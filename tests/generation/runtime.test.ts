import { expect, test } from "bun:test";
import {
  executionEnvironment,
  withExecutionEnvironment,
} from "../../src/contracts/config/execution-environment.js";
import {
  generationEnvironment,
  generationRecordPath,
  saveGenerationRecords,
} from "../../src/generation/settings/credentials.js";
import type { GenerationReference } from "../../src/generation/settings/settings.js";
import { generationSubscriptionAuth } from "../../src/harnesses/codex/subscription.js";
import { loadPiModelAuth } from "../../src/harnesses/pi/model-auth.js";
import { githubToken } from "../../src/third_party/github/token.js";
import { codexAccess, codexAuth } from "../support/codex-auth.js";
import { memoryVault } from "../support/evaluation-vault.js";

test("saved ChatGPT logins use subscription authentication without inheriting an API key", async () => {
  const vault = memoryVault();
  const credential = await vault.credentials.create(
    1,
    {
      name: "ChatGPT",
      kind: "openai",
      auth: "codex-login",
      value: codexAuth,
    },
    {},
  );
  const sandbox = await vault.credentials.create(
    1,
    { name: "Modal", kind: "modal", auth: "api-key", value: "sandbox-secret", tokenId: "id" },
    {},
  );
  const reference: GenerationReference = {
    ownerId: 1,
    repoId: 1,
    settings: {
      authorModel: "gpt-6-sol",
      verifierModel: "gpt-6-sol",
      reasoning: "high",
      modelAccess: "credential",
      sandbox: "modal",
      modelCredentialId: credential.id,
      sandboxCredentialId: sandbox.id,
    },
  };
  await vault.records.write(generationRecordPath("codex-run"), reference, 0);
  const base = {
    OPENAI_API_KEY: "host-key",
    SELFBENCH_PI_AUTH_JSON: "host-subscription",
    SELFBENCH_MANAGED_OPENROUTER_API_KEY: "platform-openrouter",
  };
  const env = await generationEnvironment(vault, "codex-run", reference, base);
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(base.OPENAI_API_KEY).toBe("host-key");
  await withExecutionEnvironment(env, async () => {
    const auth = await loadPiModelAuth();
    expect(auth.provider).toBe("openai-codex");
    expect(JSON.parse(auth.authJson ?? "")).toEqual({
      "openai-codex": {
        type: "oauth",
        access: codexAccess,
        refresh: "test-refresh",
        expires: 2000000000000,
        accountId: "test-account",
      },
    });
  });
  for (const raw of [
    "invalid",
    JSON.stringify({ tokens: { access_token: "bad", refresh_token: "secret" } }),
  ])
    expect(() => generationSubscriptionAuth(raw)).toThrow("Reconnect it in Credentials");
  expect(JSON.stringify(reference)).not.toContain("test-refresh");
});

test("generation credentials cannot be substituted and concurrent activity environments stay isolated", async () => {
  const vault = memoryVault();
  const model = await vault.credentials.create(
    1,
    { name: "Model", kind: "openai", auth: "api-key", value: "model-one" },
    {},
  );
  const sandbox = await vault.credentials.create(
    1,
    { name: "Modal", kind: "modal", auth: "api-key", value: "sandbox-one", tokenId: "id-one" },
    {},
  );
  const reference: GenerationReference = {
    ownerId: 1,
    repoId: 1,
    settings: {
      authorModel: "gpt-6-sol",
      verifierModel: "gpt-6-astra",
      reasoning: "low",
      modelAccess: "credential",
      sandbox: "modal",
      modelCredentialId: model.id,
      sandboxCredentialId: sandbox.id,
    },
  };
  await saveGenerationRecords(vault.records, "run-one", reference, "github-one");
  const env = await generationEnvironment(vault, "run-one", reference, {
    OPENAI_API_KEY: "host-key",
    MODAL_TOKEN_SECRET: "host-modal",
    GH_TOKEN: "host-github",
  });
  expect(env.OPENAI_API_KEY).toBe("model-one");
  expect(env.MODAL_TOKEN_SECRET).toBe("sandbox-one");
  expect(env.GH_TOKEN).toBe("github-one");
  await withExecutionEnvironment(env, async () => expect(await githubToken()).toBe("github-one"));
  await expect(
    generationEnvironment(vault, "run-one", { ...reference, ownerId: 2 }, {}),
  ).rejects.toThrow("saved configuration");
  await expect(generationEnvironment(vault, "run-missing", reference, {})).rejects.toThrow(
    "saved configuration",
  );
  await Promise.all(
    [env, { ...env, OPENAI_API_KEY: "model-two", MODAL_TOKEN_SECRET: "sandbox-two" }].map(
      (environment) =>
        withExecutionEnvironment(environment, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect((await loadPiModelAuth()).apiKey).toBe(environment.OPENAI_API_KEY);
          expect(executionEnvironment().MODAL_TOKEN_SECRET).toBe(environment.MODAL_TOKEN_SECRET);
        }),
    ),
  );
  expect(executionEnvironment()).toBe(process.env);
});
