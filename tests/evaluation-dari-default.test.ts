import { expect, test } from "bun:test";
import { credentialSchema } from "../src/db/credentials.js";
import { dariRouter, evaluationCatalog } from "../src/evaluation/catalog.js";
import { isDariRun } from "../src/evaluation/dari/cost.js";
import { gatewayTrial, solverAgent, solverAgentArguments } from "../src/evaluation/execution.js";
import { routeFor } from "../src/evaluation/models.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";

test("Dari Router is built in and needs only a Dari API key", () => {
  expect(evaluationCatalog().find((model) => model.id === "dari/routing")).toEqual(dariRouter);
  expect(
    credentialSchema.parse({ name: "Dari", kind: "dari", value: "test-key" }).endpoint,
  ).toBeUndefined();
  expect(routeFor(dariRouter, "dari")?.harnesses).toEqual(["pi"]);
  expect(routeFor(dariRouter, "openai")).toBeUndefined();
  expect(routeFor(dariRouter, "openrouter")).toBeUndefined();
});

test("the built-in Dari route uses the existing response-price adapter", () => {
  const input: EvaluationInput = {
    id: "test",
    repoId: 1,
    tenant: "test",
    startedBy: "test",
    createdAt: "2026-10-20T00:00:00Z",
    harnesses: ["pi"],
    sandbox: "modal",
    model: dariRouter.id,
    modelName: `${dariRouter.provider}/${dariRouter.model}`,
    tasks: [],
    credentials: {
      provider: "dari" as const,
      modelCredentialId: "key",
      sandboxCredentialId: "sandbox",
    },
  };
  const trial = gatewayTrial(input, "pi", input.modelName, {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://routing.dari.dev/v1",
  });
  expect(input.modelName).toBe("dari/routing");
  const run = initialEvaluation(input, input.modelName);
  expect(run.modelLabel).toBe("Dari Router");
  expect(trial.model).toBe("openai/dari/routing");
  expect(trial.extraAllowedHosts).toEqual(["routing.dari.dev"]);
  expect(solverAgent("pi", "dari", trial.model)).toBe("harbor_dari:DariPi");
  expect(solverAgentArguments("pi", "dari", trial.model)).toEqual([
    "--agent-kwarg",
    "model_api=openai-completions",
  ]);
  expect(isDariRun(run)).toBe(true);
});
