import { expect, test } from "bun:test";
import { saveCredential } from "../src/evaluation/credentials.js";
import { orgRecords } from "../src/evaluation/org-records.js";
import { withExecutionEnvironment } from "../src/execution-environment.js";
import { meteredSandboxExecutor } from "../src/managed/metered-sandbox.js";
import { managedModelCostUsd, managedSandboxCostUsd } from "../src/managed/pricing.js";
import { generationEnvironment } from "../src/site/generation-credentials.js";
import { generationModelRoute } from "../src/site/generation-models.js";
import type { GenerationReference } from "../src/site/generation-settings.js";
import { generationSettingsSchema } from "../src/site/generation-settings.js";
import { managedModelKey, managedOffer } from "../src/site/managed-generation.js";
import { loadPiModelAuth } from "../src/subscription-auth.js";
import { MemoryRecords } from "./support/evaluation-records.js";

const managedSettings = {
  authorModel: "gpt-5.6-sol",
  verifierModel: "claude-fable-5-1",
  reasoning: "high",
  modelAccess: "managed",
  sandbox: "managed",
} as const;

test("managed defaults are valid and every model is servable through managed OpenRouter", () => {
  expect(generationSettingsSchema.safeParse(managedSettings).success).toBe(true);
  for (const model of [
    "gpt-5.6-sol",
    "gpt-6-astra",
    "claude-fable-5-1",
    "claude-opus-5",
    "glm-5.3",
    "kimi-k3",
  ])
    expect(
      generationSettingsSchema.safeParse({ ...managedSettings, verifierModel: model }).success,
    ).toBe(true);
  // Managed selections reject credentials and separate verification settings.
  expect(
    generationSettingsSchema.safeParse({
      ...managedSettings,
      modelCredentialId: crypto.randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    generationSettingsSchema.safeParse({
      ...managedSettings,
      sandboxCredentialId: crypto.randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    generationSettingsSchema.safeParse({
      ...managedSettings,
      sandbox: "modal",
      modelAccess: "credential",
      modelCredentialId: crypto.randomUUID(),
      sandboxCredentialId: crypto.randomUUID(),
    }).success,
  ).toBe(true);
});

test("model routes resolve per credential kind", () => {
  expect(generationModelRoute("gpt-5.6-sol", undefined)).toEqual({
    provider: "openrouter",
    model: "openai/gpt-5.6-sol",
  });
  expect(generationModelRoute("claude-fable-5-1", { kind: "openai", auth: "codex-login" })).toEqual(
    { provider: "openai-codex", model: "anthropic/claude-fable-5.1" },
  );
  expect(generationModelRoute("claude-opus-5", { kind: "anthropic", auth: "api-key" })).toEqual({
    provider: "anthropic",
    model: "claude-opus-5",
  });
  expect(generationModelRoute("glm-5.3", { kind: "openrouter", auth: "api-key" })).toEqual({
    provider: "openrouter",
    model: "z-ai/glm-5.3",
  });
});

test("managed runs resolve platform keys and never inherit the worker's own credentials", async () => {
  const records = new MemoryRecords();
  const sandbox = await saveCredential(
    orgRecords(records, 1),
    1,
    { name: "Modal", kind: "modal", auth: "api-key", value: "sandbox-one", tokenId: "id-one" },
    {},
  );
  const model = await saveCredential(
    orgRecords(records, 1),
    1,
    { name: "OpenAI", kind: "openai", auth: "api-key", value: "model-one" },
    {},
  );
  const reference: GenerationReference = {
    ownerId: 1,
    orgId: 1,
    repoId: 1,
    settings: {
      ...managedSettings,
      verifierModel: "gpt-5.6-sol",
      sandbox: "modal",
      modelAccess: "credential",
      modelCredentialId: model.id,
      sandboxCredentialId: sandbox.id,
    },
  };
  await records.write(`generations/run-m`, reference, 0);
  const offer = { models: true, sandbox: true };
  const env = await generationEnvironment(records, "run-m", reference, {
    OPENAI_API_KEY: "host-key",
    MODAL_TOKEN_SECRET: "host-modal",
    SELFBENCH_MANAGED_OPENROUTER_API_KEY: "platform-openrouter",
  });
  // The host worker's own credentials are replaced by the run's stored ones.
  expect(env.OPENAI_API_KEY).toBe("model-one");
  expect(env.MODAL_TOKEN_SECRET).toBe("sandbox-one");
  await withExecutionEnvironment({ OPENROUTER_API_KEY: "router-key" }, async () =>
    expect((await loadPiModelAuth()).provider).toBe("openrouter"),
  );
  // Managed selections validate against the deployment offer.
  const managedReference: GenerationReference = {
    ...reference,
    settings: { ...managedSettings },
  };
  await records.write(`generations/run-managed`, managedReference, 0);
  const managedEnv = await generationEnvironment(records, "run-managed", managedReference, {
    SELFBENCH_MANAGED_OPENROUTER_API_KEY: "platform-openrouter",
    SELFBENCH_MANAGED_E2B_API_KEY: "platform-e2b",
  });
  expect(managedEnv.OPENROUTER_API_KEY).toBe("platform-openrouter");
  expect(managedEnv.E2B_API_KEY).toBe("platform-e2b");
  expect(managedEnv.E2B_DOMAIN).toBeUndefined();
  expect(offer).toEqual({ models: true, sandbox: true });
  // The offer follows key presence: one key set, one capability offered.
  expect(managedOffer({ SELFBENCH_MANAGED_OPENROUTER_API_KEY: "k" })).toEqual({
    models: true,
    sandbox: false,
  });
  await expect(generationEnvironment(records, "run-managed", managedReference, {})).rejects.toThrow(
    "Managed models are not available",
  );
  expect(managedModelKey({ SELFBENCH_MANAGED_OPENROUTER_API_KEY: "k" })).toBe("k");
});

test("managed usage metering records tokens and sandbox seconds with costs", async () => {
  meteredSandboxExecutor(
    {
      run: async () => ({ sandboxId: "s", exitCode: 0, stdout: "", stderr: "", outputs: {} }),
      execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async () => undefined,
      writeFile: async () => undefined,
      close: () => {},
    },
    { managedModel: true, managedSandbox: true, model: "gpt-5.6-sol" },
  );
  expect(managedSandboxCostUsd(3600, 4, 8192)).toBeCloseTo(0.3312, 4);
  expect(
    managedModelCostUsd("gpt-5.6-sol", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ).toBe(2);
  expect(
    managedModelCostUsd("unknown-model", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }),
  ).toBeUndefined();
});
