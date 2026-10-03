import { expect, test } from "bun:test";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const passTrial = (run: EvaluationRun) => {
  const [trial] = run.trials;
  if (trial) Object.assign(trial, { status: "completed", rewards: { reward: 1 } });
};
/** Run records read from `store` while `work` runs. */
async function recordsRead(store: LocalArtifactStore, work: () => Promise<unknown>) {
  const read = store.getByKey.bind(store);
  let count = 0;
  store.getByKey = (key) => {
    count += 1;
    return read(key);
  };
  try {
    await work();
  } finally {
    store.getByKey = read;
  }
  return count;
}

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
    const one = `${fixture.base}/comparisons/${record.id}`;
    expect(comparisons).toEqual([await (await fixture.request(one)).json()]);
    // The list stored the summary the older worker left out; a poll now reads no record.
    expect(await recordsRead(fixture.artifacts, () => fixture.request(one))).toBe(0);
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
