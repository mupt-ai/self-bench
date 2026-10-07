import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repriceEvaluation } from "../maintenance/reprice-vendor-rates.js";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { getEvaluation, initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

// Mistral's own endpoint at its 50% preview discount, as OpenRouter listed it on 2026-10-06.
const openRouter = (async () =>
  Response.json({
    data: {
      endpoints: [
        {
          tag: "mistral",
          pricing: {
            prompt: "0.00000068",
            completion: "0.00000209",
            input_cache_read: "0.00000007",
            discount: 0.5,
          },
        },
      ],
    },
  })) as unknown as typeof fetch;

test("reprice moves a gateway run to vendor list rates and keeps the gateway's charge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-reprice-"));
  directories.push(directory);
  const store = new LocalArtifactStore(directory);
  const task = (taskId: string) => ({ runId: "run-one", taskId, bundleKey: "tasks/task.tar.gz" });
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      model: "mistralai/mistral-large-4-0",
      modelName: "vercel-ai-gateway/mistral/mistral-large-4",
      harnesses: ["pi"],
      tasks: [task("billed"), task("estimated"), task("failed")],
      pricing: {
        input: 0.68,
        output: 2.09,
        cacheRead: 0.07,
        cacheWrite: 0.68,
        source: "https://vercel.com/ai-gateway/models/mistral-large-4",
        asOf: "2026-10-06",
      },
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "vercel-ai-gateway",
        auth: "api-key",
      },
    },
    "Mistral Large 4",
  );
  const usage = { input: 1_000_000, output: 100_000, cacheRead: 5_000_000, cacheWrite: 0 };
  const [billed, estimated, failed] = run.trials;
  if (!billed || !estimated || !failed) throw new Error("Missing trials");
  const scored = { status: "completed" as const, modelVerified: true, tokenUsage: usage };
  Object.assign(billed, { ...scored, apiCostUsd: 1.239, costSource: "gateway" });
  Object.assign(estimated, { ...scored, apiCostUsd: 1.239, costSource: "reference-rates" });
  Object.assign(failed, { status: "failed" });
  run.status = "running";
  await saveEvaluation(store, run);
  await expect(repriceEvaluation(store, run.repoId, run.id, true, openRouter)).rejects.toThrow(
    "still in progress",
  );
  run.status = "completed";
  await saveEvaluation(store, run);

  // $1.36, $4.18 and $0.14 per million: twice the preview rates.
  const listCost = (1_000_000 * 1.36 + 100_000 * 4.18 + 5_000_000 * 0.14) / 1_000_000;
  const dry = await repriceEvaluation(store, run.repoId, run.id, false, openRouter);
  expect(dry.trials.map((trial) => trial.after?.apiCostUsd)).toEqual([
    listCost,
    listCost,
    undefined,
  ]);
  expect(dry.totalCostUsd.after).toBeCloseTo(2 * listCost, 9);
  expect((await getEvaluation(store, run.repoId, run.id))?.pricing?.input).toBe(0.68);

  await repriceEvaluation(store, run.repoId, run.id, true, openRouter);
  const saved = await getEvaluation(store, run.repoId, run.id);
  expect(saved?.pricing).toMatchObject({ input: 1.36, output: 4.18, cacheRead: 0.14 });
  expect(
    saved?.trials.map(({ apiCostUsd, costSource, billedCostUsd }) => ({
      apiCostUsd,
      costSource,
      billedCostUsd,
    })),
  ).toEqual([
    { apiCostUsd: listCost, costSource: "reference-rates", billedCostUsd: 1.239 },
    { apiCostUsd: listCost, costSource: "reference-rates", billedCostUsd: undefined },
    { apiCostUsd: undefined, costSource: undefined, billedCostUsd: undefined },
  ]);
});
