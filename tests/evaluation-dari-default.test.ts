import { expect, test } from "bun:test";
import { credentialSchema } from "../src/db/credentials.js";
import { dariRouter, evaluationCatalog } from "../src/evaluation/catalog.js";
import { isDariRun } from "../src/evaluation/dari/cost.js";
import { gatewayTrial, solverAgent, solverAgentArguments } from "../src/evaluation/execution.js";
import { routeFor } from "../src/evaluation/models.js";

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
  const input = {
    modelName: "dari/dari/routing",
    credentials: {
      provider: "dari" as const,
      modelCredentialId: "key",
      sandboxCredentialId: "sandbox",
    },
  };
  const trial = gatewayTrial(input as Parameters<typeof gatewayTrial>[0], "pi", input.modelName, {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://routing.dari.dev/v1",
  });
  expect(trial.model).toBe("openai/dari/routing");
  expect(trial.extraAllowedHosts).toEqual(["routing.dari.dev"]);
  expect(solverAgent("pi", "dari", trial.model)).toBe("harbor_dari:DariPi");
  expect(solverAgentArguments("pi", "dari", trial.model)).toEqual([
    "--agent-kwarg",
    "model_api=openai-completions",
  ]);
  expect(isDariRun(input as Parameters<typeof isDariRun>[0])).toBe(true);
});
