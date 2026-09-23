import { expect, test } from "bun:test";
import { managedHarborEnvironment } from "../src/generation/billing/managed.js";
import { generationEnvironment } from "../src/generation/settings/credentials.js";
import { generationConfigEnvironment } from "../src/generation/settings/run.js";
import type { GenerationReference } from "../src/generation/settings/settings.js";
import { providerEnvironment } from "../src/sandbox/provider-environment.js";
import { memoryVault } from "./support/evaluation-vault.js";

const managedSettings = {
  authorModel: "gpt-6-sol",
  verifierModel: "claude-fable-5-1",
  reasoning: "high",
  modelAccess: "managed",
  sandbox: "managed",
} as const;

const platform = {
  SELFBENCH_MANAGED_OPENROUTER_API_KEY: "platform-openrouter",
  SELFBENCH_MANAGED_E2B_API_KEY: "platform-e2b",
};
const platformModal = {
  ...platform,
  SELFBENCH_MANAGED_MODAL_TOKEN_ID: "ak-platform",
  SELFBENCH_MANAGED_MODAL_TOKEN_SECRET: "as-platform",
  SELFBENCH_MANAGED_MODAL_ENVIRONMENT: "selfbench-prod",
};

test("managed runs verify on Modal exactly when a complete platform Modal token is set", () => {
  expect(managedHarborEnvironment(platformModal)).toBe("modal");
  expect(managedHarborEnvironment(platform)).toBe("e2b");
  expect(
    managedHarborEnvironment({ ...platform, SELFBENCH_MANAGED_MODAL_TOKEN_ID: "ak-platform" }),
  ).toBe("e2b");
  expect(generationConfigEnvironment(managedSettings, platformModal)).toMatchObject({
    SELFBENCH_EXECUTION_BACKEND: "e2b",
    SELFBENCH_HARBOR_ENVIRONMENT: "modal",
  });
  expect(generationConfigEnvironment(managedSettings, platform).SELFBENCH_HARBOR_ENVIRONMENT).toBe(
    "e2b",
  );
});

test("managed Modal verification gets the platform token, never the worker's own", async () => {
  const vault = memoryVault();
  const reference: GenerationReference = {
    ownerId: 1,
    orgId: 1,
    repoId: 1,
    settings: managedSettings,
  };
  await vault.records.write("generations/run-modal", reference, 0);
  const env = await generationEnvironment(vault, "run-modal", reference, {
    ...platformModal,
    MODAL_TOKEN_ID: "worker-id",
    MODAL_TOKEN_SECRET: "worker-secret",
  });
  expect(env.E2B_API_KEY).toBe("platform-e2b");
  expect(providerEnvironment(env, "modal")).toMatchObject({
    MODAL_TOKEN_ID: "ak-platform",
    MODAL_TOKEN_SECRET: "as-platform",
    MODAL_ENVIRONMENT: "selfbench-prod",
  });

  const e2bOnly = await generationEnvironment(vault, "run-modal", reference, {
    ...platform,
    MODAL_TOKEN_SECRET: "worker-secret",
  });
  expect(e2bOnly.MODAL_TOKEN_SECRET).toBeUndefined();
});
