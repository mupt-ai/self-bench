import { beforeEach, expect, test } from "bun:test";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { createRunSummaryStore } from "../src/db/evaluation-summaries.js";
import {
  keepRunSummaries,
  listEvaluations,
  saveEvaluation,
  updateEvaluation,
} from "../src/evaluation/store.js";
import { buildRelease, previewRelease } from "../src/public/release-build.js";
import { releaseInputs } from "../src/public/release-sources.js";
import { full, names } from "./support/release-fixture.js";
import { type ReleaseServer, releaseServerPerTest } from "./support/release-server.js";

const suite = releaseServerPerTest(["sol", "terra", "luna"]);
let server: ReleaseServer;
/** The server's runs as the API reads them, keeping summaries; and as a worker without them. */
let runs: LocalArtifactStore;
let older: LocalArtifactStore;
beforeEach(() => {
  server = suite.server;
  runs = new LocalArtifactStore(server.directory);
  keepRunSummaries(runs, createRunSummaryStore(server.db));
  older = new LocalArtifactStore(server.directory);
});

const context = {
  repository: { id: 70107786, fullName: "vercel/next.js" },
  publisher: { login: "acme", kind: "org" as const },
};
/** What a release reads now, and the same with every run's record read in full, as before. */
async function bothInputs() {
  const scope = { repoId: server.repo.id, orgId: server.line.orgId };
  const fromSummaries = await releaseInputs(server.db, runs, scope, []);
  const records = await listEvaluations(older, server.repo.id);
  return { fromSummaries, fromRecords: { ...fromSummaries, runs: records } };
}
/** Run records read by any store while `work` runs. */
async function recordsRead(work: () => Promise<unknown>): Promise<number> {
  const read = LocalArtifactStore.prototype.getByKey;
  let count = 0;
  LocalArtifactStore.prototype.getByKey = function (this: LocalArtifactStore, key: string) {
    if (key.includes("/snapshots/")) count += 1;
    return read.call(this, key);
  };
  try {
    await work();
  } finally {
    LocalArtifactStore.prototype.getByKey = read;
  }
  return count;
}

test("a release built from run summaries is the one built from run records", async () => {
  // A worker that keeps no summaries starts one run and saves a newer revision of another, with
  // a failure and a cost that change the scores: one summary is missing, one is behind.
  const [first] = await listEvaluations(older, server.repo.id);
  if (!first) throw new Error("Missing run");
  const nova = full("nova", names(1, 3), { results: { t1: 1, t2: 0, t3: 1 } });
  await saveEvaluation(older, {
    ...nova,
    repoId: server.repo.id,
    credentials: {
      modelCredentialId: server.credentialId,
      sandboxCredentialId: "s",
      provider: "openai",
    },
  });
  await updateEvaluation(older, server.repo.id, first.id, (run) => {
    const [trial] = run.trials;
    if (trial) Object.assign(trial, { rewards: { reward: 0 }, apiCostUsd: 2.5 });
  });
  const stored = await createRunSummaryStore(server.db).revisions(server.repo.id);
  // No summary for the new run; the other's is from the revision before the newer save.
  expect([stored.has(nova.id), stored.get(first.id)]).toEqual([false, first.revision]);

  const { fromSummaries, fromRecords } = await bothInputs();
  const preview = previewRelease(fromSummaries);
  expect(preview).toEqual(previewRelease(fromRecords));
  const keys = preview.settings.map((setting) => setting.key);
  expect(keys.length).toBeGreaterThan(1);
  expect(buildRelease(fromSummaries, keys, context)).toEqual(
    buildRelease(fromRecords, keys, context),
  );
  expect(buildRelease(fromSummaries, keys, { ...context, publishTasks: true })).toEqual(
    buildRelease(fromRecords, keys, { ...context, publishTasks: true }),
  );
});

test("the release dialog's preview reads no run record while the summaries stand", async () => {
  // Every run here saved its summary as it was saved.
  const preview = await server.preview();
  expect(preview.preview.settings.length).toBe(3);
  expect(await recordsRead(() => server.preview())).toBe(0);
  const { fromSummaries, fromRecords } = await bothInputs();
  expect(previewRelease(fromSummaries).fingerprint).toBe(previewRelease(fromRecords).fingerprint);
  expect((await server.release({ settings: await server.allSettings() })).status).toBe(201);
});
