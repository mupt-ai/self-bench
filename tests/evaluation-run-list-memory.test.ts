import { expect, test } from "bun:test";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { listRuns } from "../src/evaluation/run-list.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";

for (const summaries of [true, false]) {
  test(`cold run lists expand one snapshot at a time ${summaries ? "with" : "without"} summary storage`, async () => {
    const fixture = await evaluationServer();
    try {
      const older = new LocalArtifactStore(fixture.directory);
      const scope = { repoId: fixture.repo.id };
      for (let index = 0; index < 3; index += 1) {
        const input = { ...evaluationInput(), ...scope };
        await saveEvaluation(older, initialEvaluation(input, input.modelName));
      }
      const store = summaries ? fixture.artifacts : older;
      const read = store.getByKey.bind(store);
      let active = 0;
      let peak = 0;
      store.getByKey = async (key) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return await read(key);
        } finally {
          active -= 1;
        }
      };
      expect((await listRuns(store, scope)).runs).toHaveLength(3);
      expect(peak).toBe(1);
    } finally {
      await fixture.close();
    }
  });
}
