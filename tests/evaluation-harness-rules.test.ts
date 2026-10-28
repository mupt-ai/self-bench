import { expect, test } from "bun:test";
import { catalog } from "../src/evaluation/catalog.js";
import { trialCost } from "../src/evaluation/cost.js";
import {
  credentialRunsHarness,
  harnessIds,
  modelHarnesses,
  openHarnesses,
  routeFor,
  signInRefusal,
} from "../src/evaluation/models.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

test("API keys run any harness; Claude and Meta sign-ins only their CLI; ChatGPT only Codex", () => {
  for (const harness of harnessIds) {
    expect(credentialRunsHarness("api-key", harness)).toBe(true);
    expect(credentialRunsHarness("claude-login", harness)).toBe(harness === "claude-code");
    expect(credentialRunsHarness("muse-login", harness)).toBe(harness === "muse-code");
    expect(credentialRunsHarness("codex-login", harness)).toBe(harness === "codex");
  }
  expect(signInRefusal("claude-login", ["claude-code", "pi"])).toBe(
    "A Claude Code sign-in can only run the Claude Code harness",
  );
  expect(signInRefusal("muse-login", ["codex"])).toBe(
    "A Muse Code sign-in can only run the Muse Code harness",
  );
  expect(signInRefusal("api-key", [...harnessIds])).toBeUndefined();
});

test("a model offers, before a credential is chosen, every harness some route runs", () => {
  const sol = catalog.find((model) => model.id === "gpt-6-sol");
  const spark = catalog.find((model) => model.id === "muse-spark-1.3");
  if (!sol || !spark) throw new Error("Missing model fixture");
  // Gateways carry an OpenAI model to Claude Code; only Meta's API runs Muse Code.
  expect(modelHarnesses(sol)).toEqual([...openHarnesses]);
  expect(modelHarnesses(spark)).toEqual([...harnessIds]);
  // Muse Code stays a Meta key's default.
  expect(routeFor(spark, "meta")?.harnesses[0]).toBe("muse-code");
});

test("a Meta trial on another vendor's harness is priced at reference rates", () => {
  const pricing = {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 2.5,
    source: "https://provider.example/pricing",
    asOf: "2026-10-13",
  };
  const trajectory = {
    agent: { model_name: "muse-spark-1.3" },
    steps: [{ source: "agent", metrics: { prompt_tokens: 1000, completion_tokens: 100 } }],
  };
  const files = new Map([["agent/trajectory.json", JSON.stringify(trajectory)]]);
  const result = {
    agent_result: { n_input_tokens: 1000, n_cache_tokens: 0, n_output_tokens: 100 },
  };
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      modelName: "meta/muse-spark-1.3",
      pricing,
      credentials: {
        modelCredentialId: "key",
        sandboxCredentialId: "sandbox",
        provider: "meta",
        auth: "api-key",
      },
    },
    "Test",
  );
  // Harbor's figure for a Muse model under Codex comes from another vendor's table.
  const meta = { agent_result: { ...result.agent_result, cost_usd: 99 } };
  expect(trialCost(run, "codex", files, meta)).toMatchObject({
    modelVerified: true,
    apiCostUsd: 0.0028,
    costSource: "reference-rates",
  });
});
