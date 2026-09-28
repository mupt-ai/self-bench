import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactStore, LocalArtifactStore } from "../src/artifacts/index.js";
import {
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
  updateEvaluation,
} from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A local store whose every call takes as long as an object-store round trip. */
function remoteLike(store: LocalArtifactStore, latencyMs: number): ArtifactStore {
  const later = <Result>(call: () => Promise<Result>) =>
    new Promise((resolve) => setTimeout(resolve, latencyMs)).then(call);
  return Object.assign(Object.create(store) as ArtifactStore, {
    list: (prefix: string) => later(() => store.list(prefix)),
    getByKey: (key: string) => later(() => store.getByKey(key)),
    put: (key: string, value: Uint8Array, type: string) => later(() => store.put(key, value, type)),
    stat: (key: string) => later(() => store.stat(key)),
  });
}

test("a hundred trials claiming one record at once all land", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-contention-"));
  roots.push(root);
  const store = remoteLike(new LocalArtifactStore(root), 20);
  const input = evaluationInput();
  input.tasks = Array.from({ length: 100 }, (_, index) => ({
    runId: "run-one",
    taskId: `task-${index}`,
    bundleKey: "tasks/task.tar.gz",
  }));
  await saveEvaluation(store, initialEvaluation(input, "Model"));
  await Promise.all(
    input.tasks.map((_, index) =>
      updateEvaluation(store, input.repoId, input.id, (run) => {
        const trial = run.trials[index];
        if (trial) trial.status = "running";
      }),
    ),
  );
  const run = await getEvaluation(store, input.repoId, input.id);
  expect(run?.trials.filter((trial) => trial.status === "running")).toHaveLength(100);
}, 60_000);
