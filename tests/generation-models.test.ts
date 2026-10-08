import { afterEach, expect, test } from "bun:test";
import { routeFor } from "../src/evaluation/models.js";
import { gatewayIds, setGatewayListing } from "../src/gateways/index.js";
import { managedModelCostUsd } from "../src/generation/billing/pricing.js";
import { generationRoutes, stageAuthoring } from "../src/generation/settings/credentials.js";
import {
  generationCredentialRuns,
  generationModel,
  generationModelPricing,
  generationModelRoute,
} from "../src/generation/settings/models.js";
import type { GenerationSettings } from "../src/generation/settings/settings.js";
import { memoryVault } from "./support/evaluation-vault.js";

afterEach(() => {
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
});

test("generation offers the run page's models, gateway-listed ones included", () => {
  setGatewayListing("openrouter", {
    models: [{ id: "qwen/qwen4-coder", label: "Qwen4 Coder" }],
    rates: new Map([["qwen/qwen4-coder", { rates: [1, 4, 0.1, 1], asOf: "2026-09-29" }]]),
  });
  const qwen = generationModel("qwen/qwen4-coder");
  if (!qwen) throw new Error("Missing model");
  expect(qwen.label).toBe("Qwen4 Coder");
  expect(generationModelRoute(qwen.id, undefined)).toEqual({
    provider: "openrouter",
    model: "qwen/qwen4-coder",
  });
  expect(generationModelPricing(qwen.id)).toEqual(routeFor(qwen, "openrouter")?.pricing);
  expect(generationModelPricing(qwen.id)).toMatchObject({ input: 1, output: 4 });
  // Only the gateways that list a model run it, and a vendor's key runs only its own models.
  expect(generationCredentialRuns(qwen, { kind: "openrouter", auth: "api-key" })).toBe(true);
  expect(generationCredentialRuns(qwen, { kind: "vercel-ai-gateway", auth: "api-key" })).toBe(
    false,
  );
  expect(generationCredentialRuns(qwen, { kind: "openai", auth: "api-key" })).toBe(false);
  expect(generationModel("not-listed")).toBeUndefined();
});

const managed: GenerationSettings = {
  authorModel: "gpt-6.1-sol",
  verifierModel: "gpt-6.1-sol",
  reasoning: "high",
  modelAccess: "managed",
  sandbox: "managed",
};

test("submission refuses a model the catalog does not offer, or managed access cannot run", async () => {
  const vault = memoryVault();
  await generationRoutes(vault.credentials, 1, managed);
  await expect(
    generationRoutes(vault.credentials, 1, { ...managed, authorModel: "gone" }),
  ).rejects.toThrow("gone is not an available model.");
  // Vercel alone lists this one, so OpenRouter behind the platform key cannot run it.
  setGatewayListing("vercel-ai-gateway", {
    models: [{ id: "alibaba/qwen4-max", label: "Qwen4 Max" }],
    rates: new Map(),
  });
  await expect(
    generationRoutes(vault.credentials, 1, { ...managed, verifierModel: "qwen/qwen4-max" }),
  ).rejects.toThrow("Qwen4 Max is not available with managed models.");
});

test("a run keeps the routes and rates it was submitted with after the gateways drop its model", async () => {
  setGatewayListing("openrouter", {
    models: [{ id: "qwen/qwen4-coder", label: "Qwen4 Coder" }],
    rates: new Map([["qwen/qwen4-coder", { rates: [1, 4, 0.1, 1], asOf: "2026-09-29" }]]),
  });
  const vault = memoryVault();
  const settings = {
    ...managed,
    authorModel: "qwen/qwen4-coder",
    verifierModel: "qwen/qwen4-coder",
  };
  const routes = await generationRoutes(vault.credentials, 1, settings);
  expect(routes.author).toEqual({
    provider: "openrouter",
    model: "qwen/qwen4-coder",
    rates: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
  });
  setGatewayListing("openrouter", { models: [], rates: new Map() });
  expect(generationModel("qwen/qwen4-coder")).toBeUndefined();
  const reference = { ownerId: 1, repoId: 1, settings, routes };
  expect(await stageAuthoring(vault.credentials, reference, "verifier")).toEqual({
    ...routes.verifier,
    reasoningEffort: "high",
  });
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect(managedModelCostUsd("qwen/qwen4-coder", tokens)).toBeUndefined();
  expect(managedModelCostUsd("qwen/qwen4-coder", tokens, routes.author.rates)).toBe(1);
});
