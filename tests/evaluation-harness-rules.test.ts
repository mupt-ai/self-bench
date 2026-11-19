import { expect, test } from "bun:test";
import { catalog } from "../src/evaluation/catalog.js";
import { trialCost } from "../src/evaluation/cost.js";
import { credentialRoute, linkedCatalogModels } from "../src/evaluation/link-routes.js";
import { harnessIds, modelHarnesses, openHarnesses, routeFor } from "../src/evaluation/models.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import type { DariLinkModels } from "../src/gateway/dari-link/connection.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

test("a Dari connection runs what its grant serves: any harness, or a Claude or Muse plan's own agent alone", () => {
  const sol = catalog.find((model) => model.id === "gpt-6-sol");
  const opus = catalog.find((model) => model.id === "claude-opus-5-5");
  const luna = catalog.find((model) => model.id === "gpt-6-luna");
  const spark = catalog.find((model) => model.id === "muse-spark-1.3");
  if (!sol || !opus || !luna || !spark) throw new Error("Missing model fixture");
  const linked = (linkModels: DariLinkModels) => ({ kind: "dari-link" as const, linkModels });
  const plans = linked({
    models: [
      { id: "openai/gpt-6-sol" },
      { id: "anthropic/claude-opus-5-5", only: "claude-code" },
      { id: "meta/muse-spark-1.3", only: "muse-code" },
      { id: "opencode-go/glm-5.3", name: "GLM 5.3" },
    ],
    prefixes: [],
  });
  // Dari's id for the model, which the trial's child token names, under the connection.
  expect(credentialRoute(sol, plans)).toMatchObject({
    provider: "dari-link",
    model: "openai/gpt-6-sol",
    harnesses: [...openHarnesses],
  });
  expect(credentialRoute(opus, plans)?.harnesses).toEqual(["claude-code"]);
  expect(credentialRoute(spark, plans)?.harnesses).toEqual(["muse-code"]);
  // A Meta key serves its models to any app, Muse Code included.
  expect(
    credentialRoute(spark, linked({ models: [{ id: "meta/muse-spark-1.3" }], prefixes: [] }))
      ?.harnesses,
  ).toEqual([...openHarnesses, "muse-code"]);
  expect(credentialRoute(luna, plans)).toBeUndefined();
  // A gateway key serves the catalog's models by the gateway's id.
  expect(credentialRoute(luna, linked({ models: [], prefixes: ["openrouter/"] }))?.model).toBe(
    "openrouter/openai/gpt-6-luna",
  );
  // What the catalog does not list is offered on the connection by Dari's id and name.
  const [glm, ...others] = linkedCatalogModels(catalog, [plans]);
  expect(others).toEqual([]);
  expect(glm).toMatchObject({ id: "opencode-go/glm-5.3", label: "GLM 5.3" });
  expect(glm && credentialRoute(glm, plans)?.harnesses).toEqual([...openHarnesses]);
  expect(glm && credentialRoute(glm, linked({ models: [], prefixes: [] }))).toBeUndefined();
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
