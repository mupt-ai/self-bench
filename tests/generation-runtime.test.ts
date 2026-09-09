import { expect, test } from "bun:test";
import { saveCredential } from "../src/evaluation/credentials.js";
import { executionEnvironment, withExecutionEnvironment } from "../src/execution-environment.js";
import { generationEnvironment, generationRecordPath } from "../src/site/generation-credentials.js";
import type { GenerationReference } from "../src/site/generation-settings.js";
import { loadPiModelAuth } from "../src/subscription-auth.js";
import {
  authoringRoundScript,
  verifierRoundScript,
} from "../src/temporal/activities/agent-scripts.js";
import { MemoryRecords } from "./support/evaluation-records.js";

test("generation credentials cannot be substituted and concurrent activity environments stay isolated", async () => {
  const records = new MemoryRecords();
  const model = await saveCredential(
    records,
    1,
    { name: "Model", kind: "openai", auth: "api-key", value: "model-one" },
    {},
  );
  const sandbox = await saveCredential(
    records,
    1,
    { name: "Modal", kind: "modal", auth: "api-key", value: "sandbox-one", tokenId: "id-one" },
    {},
  );
  const reference: GenerationReference = {
    ownerId: 1,
    repoId: 1,
    settings: {
      authorModel: "gpt-5.6-sol",
      verifierModel: "gpt-6-astra",
      reasoning: "low",
      sandbox: "modal",
      modelCredentialId: model.id,
      sandboxCredentialId: sandbox.id,
    },
  };
  await records.write(generationRecordPath("run-one"), reference, 0);
  const env = await generationEnvironment(records, "run-one", reference, {
    OPENAI_API_KEY: "host-key",
    MODAL_TOKEN_SECRET: "host-modal",
  });
  expect(env.OPENAI_API_KEY).toBe("model-one");
  expect(env.MODAL_TOKEN_SECRET).toBe("sandbox-one");
  await expect(
    generationEnvironment(records, "run-one", { ...reference, ownerId: 2 }, {}),
  ).rejects.toThrow("saved configuration");
  await expect(generationEnvironment(records, "run-missing", reference, {})).rejects.toThrow(
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
  for (const script of [authoringRoundScript(false), verifierRoundScript(false)]) {
    expect(script).toContain(`--thinking "\${AUTHOR_THINKING:-high}"`);
    expect(script).not.toContain("--thinking high");
  }
});
