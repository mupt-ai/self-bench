import { expect, test } from "bun:test";
import { referencePricing } from "../../src/evaluation/catalog.js";
import { trialCost } from "../../src/evaluation/cost.js";
import { initialEvaluation } from "../../src/evaluation/store.js";
import { evaluationInput } from "../support/evaluation-fixture.js";

test("Muse Code prices each known model in a mixed-model Meta session", () => {
  const wonder = referencePricing("muse-wonder-1.0", "meta", "muse-wonder-1.0");
  const spark = referencePricing("muse-spark-1.3", "meta", "muse-spark-1.3");
  if (!wonder || !spark) throw new Error("Missing Muse reference pricing");
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      model: "muse-wonder-1.0",
      modelName: "meta/muse-wonder-1.0",
      harnesses: ["muse-code"],
      pricing: wonder,
      credentials: {
        modelCredentialId: "muse",
        sandboxCredentialId: "sandbox",
        provider: "meta",
        auth: "muse-login",
      },
    },
    "Muse Wonder",
  );
  const call = (model: string, input: number, output: number, cached: number) => ({
    source: "agent",
    model_name: model,
    metrics: {
      prompt_tokens: input + cached,
      completion_tokens: output,
      cached_tokens: cached,
    },
  });
  const trajectory = {
    steps: [
      call("muse-wonder-1.0", 1000, 100, 200),
      call("muse-spark-1.3", 2000, 200, 400),
      call("<synthetic>", 0, 0, 0),
    ],
  };
  const result = {
    agent_result: {
      n_input_tokens: 3600,
      n_cache_tokens: 600,
      n_output_tokens: 300,
    },
  };
  const files = new Map([["solver/trial/agent/trajectory.json", JSON.stringify(trajectory)]]);
  const priced = trialCost(run, "muse-code", files, result);
  expect(priced).toMatchObject({
    modelVerified: true,
    tokenUsage: { input: 3000, output: 300, cacheRead: 600, cacheWrite: 0 },
    costSource: "reference-rates",
  });
  const wonderCost = (1000 * wonder.input + 100 * wonder.output + 200 * wonder.cacheRead) / 1e6;
  const sparkCost = (2000 * spark.input + 200 * spark.output + 400 * spark.cacheRead) / 1e6;
  expect(priced.apiCostUsd).toBeCloseTo(wonderCost + sparkCost, 12);

  const unknown = trialCost(
    run,
    "muse-code",
    new Map([
      [
        "solver/trial/agent/trajectory.json",
        JSON.stringify({
          steps: [
            call("muse-wonder-1.0", 1000, 100, 200),
            call("unknown-model", 2000, 200, 400),
            call("<synthetic>", 0, 0, 0),
          ],
        }),
      ],
    ]),
    result,
  );
  expect(unknown).toEqual({
    modelVerified: false,
    tokenUsage: { input: 3000, output: 300, cacheRead: 600, cacheWrite: 0 },
  });
});
