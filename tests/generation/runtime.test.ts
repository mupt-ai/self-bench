import { expect, test } from "bun:test";
import {
  executionEnvironment,
  withExecutionEnvironment,
} from "../../src/contracts/config/execution-environment.js";
import {
  generationEnvironment,
  saveGenerationRecords,
} from "../../src/generation/settings/credentials.js";
import type { GenerationReference } from "../../src/generation/settings/settings.js";
import { loadPiModelAuth } from "../../src/harnesses/pi/model-auth.js";
import { githubToken } from "../../src/third_party/github/token.js";
import { memoryVault } from "../support/evaluation-vault.js";

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
          expect((await loadPiModelAuth()).apiKey).toBe(environment.OPENAI_API_KEY ?? "");
          expect(executionEnvironment().MODAL_TOKEN_SECRET).toBe(environment.MODAL_TOKEN_SECRET);
        }),
    ),
  );
  expect(executionEnvironment()).toBe(process.env);
});
