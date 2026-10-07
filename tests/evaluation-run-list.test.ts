import { afterAll, beforeAll, expect, test } from "bun:test";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import type { RunSummaryStore } from "../src/db/evaluation-summaries.js";
import { listRuns } from "../src/evaluation/run-list.js";
import {
  getEvaluation,
  initialEvaluation,
  keepRunSummaries,
  listEvaluations,
  saveEvaluation,
  updateEvaluation,
} from "../src/evaluation/store.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";

let server: Awaited<ReturnType<typeof evaluationServer>>;
/** The same directory through a store that keeps no summaries: a worker from before them. */
let older: LocalArtifactStore;
beforeAll(async () => {
  server = await evaluationServer();
  older = new LocalArtifactStore(server.directory);
});
afterAll(async () => {
  await server.close();
});

/** A saved run with a transcript and a log, which lists leave out. */
async function savedRun(store = server.artifacts, createdAt = new Date().toISOString()) {
  const input = { ...evaluationInput(), repoId: server.repo.id, createdAt };
  const run = initialEvaluation(input, input.modelName);
  const [trial] = run.trials;
  if (!trial) throw new Error("Missing trial");
  trial.log = "harbor output\n".repeat(50);
  trial.steps = [{ id: "step", role: "agent", text: "transcript", tools: [] }];
  trial.artifacts = ["0/solver/task/result.json"];
  await saveEvaluation(store, run);
  return run;
}
const passTrial = (run: EvaluationRun) => {
  const [trial] = run.trials;
  if (trial) Object.assign(trial, { status: "completed", rewards: { reward: 1 } });
};
/** What lists returned before summaries: every record read, and stripped. */
async function fromRecords() {
  return (await listEvaluations(older, server.repo.id)).map((run) => ({
    ...run,
    trials: run.trials.map((trial) => ({ ...trial, log: "", steps: [], artifacts: [] })),
  }));
}
/** Counts records read from `store` (the server's by default) while `work` runs, `slowMs` slower. */
async function recordsRead(
  work: () => Promise<unknown>,
  { store = server.artifacts, slowMs = 0 }: { store?: LocalArtifactStore; slowMs?: number } = {},
): Promise<number> {
  const read = store.getByKey.bind(store);
  let count = 0;
  store.getByKey = async (key) => {
    count += 1;
    if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
    return read(key);
  };
  try {
    await work();
  } finally {
    store.getByKey = read;
  }
  return count;
}
const listed = async () => (await (await server.request(server.base)).json()).runs;
/** The repository's summary revisions once `done` holds: a list saves what it rebuilds behind it. */
async function storedWhen(done: (revisions: Map<string, number>) => boolean) {
  for (let tries = 0; tries < 100; tries += 1) {
    const revisions = await server.summaries.revisions(server.repo.id);
    if (done(revisions)) return revisions;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return server.summaries.revisions(server.repo.id);
}

test("a save writes the run's summary, and a list reads summaries, not records", async () => {
  const first = await savedRun(server.artifacts, "2026-01-01T00:00:00.000Z");
  const second = await savedRun(server.artifacts, "2026-01-02T00:00:00.000Z");
  await updateEvaluation(server.artifacts, server.repo.id, first.id, passTrial);
  expect(await server.summaries.revisions(server.repo.id)).toEqual(
    new Map([
      [first.id, 2],
      [second.id, 1],
    ]),
  );
  let runs: EvaluationRun[] = [];
  expect(
    await recordsRead(async () => {
      runs = await listed();
    }),
  ).toBe(0);
  // The same list, in the same order, as reading every record gives.
  expect(runs).toEqual(await fromRecords());
  expect(runs.map((run) => run.id)).toEqual([second.id, first.id]);
  expect(runs[1]?.trials[0]).toMatchObject({ status: "completed", log: "", steps: [] });
});

test("a run saved without its summary is listed, and its summary rebuilt once", async () => {
  // A worker on older code: one run it started, and a newer save of a run that has a summary.
  const unseen = await savedRun(older);
  const known = await savedRun();
  await updateEvaluation(older, server.repo.id, known.id, passTrial);
  const revisions = await server.summaries.revisions(server.repo.id);
  expect(revisions.has(unseen.id)).toBe(false);
  expect(revisions.get(known.id)).toBe(1);

  let runs: EvaluationRun[] = [];
  expect(
    await recordsRead(async () => {
      runs = await listed();
    }),
  ).toBe(2);
  expect(runs).toEqual(await fromRecords());
  expect(runs.find((run) => run.id === known.id)?.trials[0]?.status).toBe("completed");
  expect(runs.some((run) => run.id === unseen.id)).toBe(true);
  // Both summaries now stand, so the next list reads no record.
  const rebuilt = await storedWhen((stored) => stored.get(known.id) === 2 && stored.has(unseen.id));
  expect([rebuilt.get(unseen.id), rebuilt.get(known.id)]).toEqual([1, 2]);
  expect(await recordsRead(listed)).toBe(0);
});

test("an older revision's summary never replaces a newer one", async () => {
  // A run the bucket does not have, so lists leave its summary out.
  const id = crypto.randomUUID();
  const summary = (revision: number) => ({ id, revision, body: `{"revision":${revision}}` });
  await server.summaries.save(server.repo.id, summary(5));
  await server.summaries.save(server.repo.id, summary(3));
  expect((await server.summaries.list(server.repo.id)).find((entry) => entry.id === id)).toEqual(
    summary(5),
  );
  await server.summaries.save(server.repo.id, summary(6));
  expect((await server.summaries.revisions(server.repo.id)).get(id)).toBe(6);
  // A repository disconnected while its run saves has no summaries to keep, and that is no error.
  await server.summaries.save(987_654, summary(1));
  expect(await server.summaries.list(987_654)).toEqual([]);
  expect((await listed()).some((run: EvaluationRun) => run.id === id)).toBe(false);
});

test("a save succeeds when its summary cannot be saved, and the list still has the run", async () => {
  const directory = server.directory;
  const failing = new LocalArtifactStore(directory);
  let attempts = 0;
  const refused: RunSummaryStore = {
    ...server.summaries,
    save: async () => {
      attempts += 1;
      // As a failed query reads: its message repeats the summary, its cause says what happened.
      throw new Error(`Failed query: insert ... params: ${"x".repeat(5000)}`, {
        cause: new Error("database unavailable"),
      });
    },
  };
  keepRunSummaries(failing, refused);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  let run: EvaluationRun;
  try {
    run = await savedRun(failing);
    // A database that is down is not asked again at once: the next saves do not wait on it.
    await updateEvaluation(failing, server.repo.id, run.id, passTrial);
  } finally {
    console.warn = warn;
  }
  expect((await getEvaluation(failing, server.repo.id, run.id))?.revision).toBe(2);
  expect(attempts).toBe(1);
  expect(warnings).toEqual([
    `evaluation ${run.id}: summary of revision 1 not saved: database unavailable`,
  ]);
  expect((await listed()).some((entry: EvaluationRun) => entry.id === run.id)).toBe(true);
});

test("a list stores the summaries it rebuilds, however slow the database and while saves pause", async () => {
  // As on a busy server: every save takes longer than a run's save may wait, and the first
  // run's own save has just failed, so run saves are paused.
  const busy = new LocalArtifactStore(server.directory);
  let calls = 0;
  const slow: RunSummaryStore = {
    ...server.summaries,
    save: async (repoId, summary) => {
      calls += 1;
      if (calls === 1) throw new Error("database unavailable");
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await server.summaries.save(repoId, summary);
    },
  };
  keepRunSummaries(busy, slow);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    const first = await savedRun(busy);
    const second = await savedRun(busy);
    expect(calls).toBe(1);
    // Neither has a summary yet: the list rebuilds both, answers without waiting for the slow
    // saves, and the saves still store them.
    const started = Date.now();
    const { runs } = await listRuns(busy, server.repo.id);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(runs?.some((run) => run.id === first.id)).toBe(true);
    const stored = await storedWhen(
      (revisions) => revisions.has(first.id) && revisions.has(second.id),
    );
    expect([stored.get(first.id), stored.get(second.id)]).toEqual([1, 1]);
    expect(warnings).toEqual([
      `evaluation ${first.id}: summary of revision 1 not saved: database unavailable`,
    ]);
  } finally {
    console.warn = warn;
  }
}, 15_000);

test("a poll that sends the list's tag is told when nothing changed, without the list", async () => {
  const run = await savedRun();
  const first = await server.request(server.base);
  const tag = first.headers.get("etag") ?? "";
  expect(tag).toMatch(/^"[\w-]{27}"$/);
  expect(first.headers.get("cache-control")).toBe("no-store");
  await first.arrayBuffer();

  const unchanged = await server.request(server.base, { headers: { "if-none-match": tag } });
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get("etag")).toBe(tag);
  // Neither answer may be stored: the page keeps its last list in memory only.
  expect(unchanged.headers.get("cache-control")).toBe("no-store");
  expect(await unchanged.text()).toBe("");
  // An unchanged poll reads no summary bodies: only the tag is worked out.
  expect((await listRuns(server.artifacts, server.repo.id, tag.slice(1, -1))).runs).toBeUndefined();

  await updateEvaluation(server.artifacts, server.repo.id, run.id, passTrial);
  const changed = await server.request(server.base, { headers: { "if-none-match": tag } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(tag);
  const { runs } = await changed.json();
  expect(runs.find((entry: EvaluationRun) => entry.id === run.id).trials[0].status).toBe(
    "completed",
  );
  // Another repository's tag, or a stranger's request, gets nothing from this one.
  expect((await server.request(server.base, { headers: { "if-none-match": tag } }, 2)).status).toBe(
    404,
  );
});

test("overlapping lists share one read of a record that needs rebuilding", async () => {
  await savedRun(older);
  // Slow reads, so all three lists arrive while the first is still reading, however busy CI is.
  expect(
    await recordsRead(() => Promise.all([listed(), listed(), listed()]), { slowMs: 500 }),
  ).toBe(1);
});

test("a store that keeps no summaries lists from the records, as before", async () => {
  const { tag, runs } = await listRuns(older, server.repo.id);
  expect(runs).toEqual(await fromRecords());
  expect((await listRuns(older, server.repo.id, tag)).runs).toBeUndefined();
});
