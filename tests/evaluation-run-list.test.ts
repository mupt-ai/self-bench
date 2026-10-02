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
import { memoryVault } from "./support/evaluation-vault.js";

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
/** Counts the records read while `work` runs. */
async function recordsRead(work: () => Promise<unknown>): Promise<number> {
  const read = server.artifacts.getByKey.bind(server.artifacts);
  let count = 0;
  server.artifacts.getByKey = (key) => {
    count += 1;
    return read(key);
  };
  try {
    await work();
  } finally {
    server.artifacts.getByKey = read;
  }
  return count;
}
const listed = async () => (await (await server.request(server.base)).json()).runs;

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
  const rebuilt = await server.summaries.revisions(server.repo.id);
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
  expect(await recordsRead(() => Promise.all([listed(), listed(), listed()]))).toBe(1);
});

test("a store that keeps no summaries lists from the records, as before", async () => {
  const { tag, runs } = await listRuns(older, server.repo.id);
  expect(runs).toEqual(await fromRecords());
  expect((await listRuns(older, server.repo.id, tag)).runs).toBeUndefined();
});

test("saved comparisons take their progress from summaries, as their own pages do from records", async () => {
  const vault = memoryVault();
  const fixture = await evaluationServer(vault);
  try {
    const inputs = [0, 1, 2].map(() => ({ ...evaluationInput(), repoId: fixture.repo.id }));
    const [done, live] = inputs;
    if (!done || !live) throw new Error("Missing inputs");
    const record = {
      id: crypto.randomUUID(),
      orgId: 1,
      repoId: fixture.repo.id,
      createdAt: new Date().toISOString(),
      signature: "test",
      inputs,
    };
    await vault.comparisons.insert(record);
    const finished = initialEvaluation(done, done.modelName);
    finished.status = "completed";
    passTrial(finished);
    await saveEvaluation(fixture.artifacts, finished);
    // Started by a worker that keeps no summaries; the third run was never started.
    const running = initialEvaluation(live, live.modelName);
    running.status = "running";
    await saveEvaluation(new LocalArtifactStore(fixture.directory), running);

    const { comparisons } = await (await fixture.request(`${fixture.base}/comparisons`)).json();
    expect(comparisons).toEqual([
      await (await fixture.request(`${fixture.base}/comparisons/${record.id}`)).json(),
    ]);
    expect(
      comparisons[0].runs.map((run: { status: string; completed: number }) => [
        run.status,
        run.completed,
      ]),
    ).toEqual([
      ["completed", 1],
      ["running", 0],
      ["pending", 0],
    ]);
  } finally {
    await fixture.close();
  }
});
