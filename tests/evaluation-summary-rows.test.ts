import { afterAll, beforeAll, expect, test } from "bun:test";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";

let server: Awaited<ReturnType<typeof evaluationServer>>;
beforeAll(async () => {
  server = await evaluationServer();
});
afterAll(async () => {
  await server.close();
});

/** The stored summary of `id`, once `done` holds for its revision. */
async function storedWhen(id: string, done: (revision: number | undefined) => boolean) {
  for (let tries = 0; tries < 100; tries += 1) {
    const revisions = await server.summaries.revisions(server.repo.id);
    if (done(revisions.get(id))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await server.summaries.list(server.repo.id)).find((entry) => entry.id === id);
}

test("a stored summary that does not read as a run is rebuilt from the record and written over", async () => {
  const input = { ...evaluationInput(), repoId: server.repo.id };
  const run = initialEvaluation(input, input.modelName);
  await saveEvaluation(server.artifacts, run);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    for (const body of ["not json", '{"id":"x"}', "null", "[]"]) {
      // Written over the stored summary at its own revision, as a damaged row would be.
      await server.summaries.save(server.repo.id, { id: run.id, revision: run.revision, body });
      const { runs } = await (await server.request(server.base)).json();
      const listed = runs.find((entry: EvaluationRun) => entry.id === run.id);
      expect(listed?.trials).toHaveLength(1);
      expect(listed?.status).toBe("queued");
      // The rebuild wrote the summary back.
      const stored = await storedWhen(run.id, (revision) => revision === run.revision);
      expect(stored?.body).not.toBe(body);
      expect(JSON.parse(stored?.body ?? "").id).toBe(run.id);
    }
    expect(warnings).toEqual(
      Array(4).fill(`evaluation ${run.id}: stored summary does not read as a run; rebuilt`),
    );
  } finally {
    console.warn = warn;
  }
});

test("a rebuild writes the same revision's summary over a stored one, never an older one", async () => {
  const id = crypto.randomUUID();
  const summary = (revision: number, body: string) => ({ id, revision, body });
  await server.summaries.save(server.repo.id, summary(3, "three"));
  await server.summaries.save(server.repo.id, summary(3, "three again"));
  await server.summaries.save(server.repo.id, summary(2, "two"));
  const stored = (await server.summaries.list(server.repo.id)).find((entry) => entry.id === id);
  expect(stored).toEqual(summary(3, "three again"));
});
