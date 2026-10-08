import { afterEach, expect, test } from "bun:test";
import { routeFor } from "../src/evaluation/models.js";
import { gatewayIds, setGatewayListing } from "../src/gateways/index.js";
import { checkGenerationCredentials } from "../src/generation/settings/credentials.js";
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

test("submission refuses a model the catalog does not offer, or managed access cannot run", async () => {
  const vault = memoryVault();
  const settings: GenerationSettings = {
    authorModel: "gpt-6.1-sol",
    verifierModel: "gpt-6.1-sol",
    reasoning: "high",
    modelAccess: "managed",
    sandbox: "managed",
  };
  const offer = { models: true, sandbox: true };
  await checkGenerationCredentials(vault.credentials, 1, settings, offer);
  await expect(
    checkGenerationCredentials(vault.credentials, 1, { ...settings, authorModel: "gone" }, offer),
  ).rejects.toThrow("gone is not an available model.");
  // Vercel alone lists this one, so OpenRouter behind the platform key cannot run it.
  setGatewayListing("vercel-ai-gateway", {
    models: [{ id: "alibaba/qwen4-max", label: "Qwen4 Max" }],
    rates: new Map(),
  });
  await expect(
    checkGenerationCredentials(
      vault.credentials,
      1,
      { ...settings, verifierModel: "qwen/qwen4-max" },
      offer,
    ),
  ).rejects.toThrow("Qwen4 Max is not available with managed models.");
});
