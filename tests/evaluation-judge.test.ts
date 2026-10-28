import { expect, test } from "bun:test";
import { credentialExecution } from "../src/evaluation/execution.js";
import { judgeCredentialRefusal, judgeEnvironment, judgeTrial } from "../src/evaluation/judge.js";
import { harborRunArguments } from "../src/harnesses/harbor/command.js";
import {
  hostVariableRefusal,
  hostVariables,
  judgeNeeds,
} from "../src/harnesses/harbor/host-variables.js";
import { credentialedInput } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

/** harveyai/lab's judge reads its key in verifier.env; tau3 also plays a user in the sandbox. */
const harvey = {
  verifier: {
    timeout_sec: 1800,
    env: {
      ANTHROPIC_API_KEY: `\${ANTHROPIC_API_KEY}`,
      JUDGE_CONCURRENCY: `\${JUDGE_CONCURRENCY:-8}`,
    },
  },
};
const tau3 = {
  environment: {
    env: {
      OPENAI_API_KEY: `\${OPENAI_API_KEY}`,
      OPENAI_BASE_URL: `\${OPENAI_BASE_URL}`,
      TAU2_USER_MODEL: `\${TAU2_USER_MODEL:-gpt-5.2}`,
    },
  },
  verifier: { env: { OPENAI_API_KEY: `\${OPENAI_API_KEY}`, MODE: "strict" } },
};

test("a published task may read judge variables, literal values, and defaulted variables", () => {
  expect(hostVariables(harvey)).toEqual([
    { name: "ANTHROPIC_API_KEY", verifierOnly: true, required: true },
    { name: "JUDGE_CONCURRENCY", verifierOnly: true, required: false, fallback: "8" },
  ]);
  expect(judgeNeeds(harvey)).toEqual({
    variables: ["ANTHROPIC_API_KEY"],
    required: ["ANTHROPIC_API_KEY"],
  });
  expect(judgeNeeds(tau3).required).toEqual(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  // senior-swe-bench's judge keys all have defaults: a judge credential still fills them.
  expect(judgeNeeds({ verifier: { env: { OPENAI_API_KEY: "$" + "{OPENAI_API_KEY:-}" } } })).toEqual(
    { variables: ["OPENAI_API_KEY"], required: [] },
  );
  expect(hostVariableRefusal(harvey)).toBeUndefined();
  expect(hostVariableRefusal(tau3)).toBeUndefined();
  // Only a whole `${NAME}` value reads the host, as in Harbor; anything else is literal.
  expect(hostVariableRefusal({ verifier: { env: { NOTE: `uses \${MODAL_TOKEN_SECRET}` } } })).toBe(
    undefined,
  );
  expect(hostVariableRefusal({ solution: { env: { LEAK: `\${MODAL_TOKEN_SECRET}` } } })).toBe(
    "task.toml reads the host variable MODAL_TOKEN_SECRET",
  );
  // Free-form metadata is never read as configuration.
  expect(hostVariables({ metadata: { env: { X: `\${SECRET}` } } })).toEqual([]);
});

/** The gateway connection a trial's judge calls through. */
const connection = {
  key: "trial-key",
  openAiBase: "https://api.selfbench.test/gateway/v1",
  anthropicBase: "https://api.selfbench.test/gateway",
};

test("a judge reaches any model of its credential's provider through the gateway", () => {
  const key = (kind: string, auth = "api-key") => ({ kind, auth }) as never;
  // The gateway speaks both protocols for every provider, so every judge variable is given.
  expect(judgeEnvironment(connection)).toEqual({
    OPENAI_API_KEY: "trial-key",
    OPENAI_BASE_URL: connection.openAiBase,
    OPENAI_API_BASE: connection.openAiBase,
    ANTHROPIC_API_KEY: "trial-key",
    ANTHROPIC_BASE_URL: connection.anthropicBase,
    OPENROUTER_API_KEY: "trial-key",
    OPENROUTER_API_BASE: connection.openAiBase,
  });
  for (const kind of ["openai", "anthropic", "meta", "openrouter", "vercel-ai-gateway"])
    expect(judgeCredentialRefusal(key(kind))).toBeUndefined();
  // A custom endpoint or Dari's router has no catalog to serve any model of, and a sign-in drives
  // only its own CLI.
  for (const credential of [key("custom"), key("dari"), key("anthropic", "claude-login")])
    expect(judgeCredentialRefusal(credential)).toBe(
      "The judge credential must be an API key for a model provider or a gateway",
    );
});

test("a trial gives the judge its key without touching the solver's own", () => {
  const judge = judgeEnvironment(connection);
  const solver = { PATH: "/usr/bin", OPENAI_API_KEY: "solver-key" };
  // The verifier gets the key by --verifier-env, as a template the run's environment answers.
  const graded = judgeTrial(hostVariables(harvey), solver, judge);
  if ("refusal" in graded) throw new Error(graded.refusal);
  expect(graded.verifierEnv).toEqual([`ANTHROPIC_API_KEY=\${SELFBENCH_JUDGE_ANTHROPIC_API_KEY}`]);
  expect(graded.child).toEqual({ ...solver, SELFBENCH_JUDGE_ANTHROPIC_API_KEY: "trial-key" });
  expect(
    harborRunArguments({
      taskPath: "/task",
      jobsPath: "/jobs",
      jobName: "solver",
      environment: "docker",
      agent: "oracle",
      verifierEnv: graded.verifierEnv,
    }).join(" "),
  ).toContain(`--ve ANTHROPIC_API_KEY=\${SELFBENCH_JUDGE_ANTHROPIC_API_KEY}`);

  // A sandbox variable is Harbor's own environment. The judge's key is its own, so where the model
  // under test holds the same variable the judge cannot share it; where it does not, the judge may.
  expect(judgeTrial(hostVariables(tau3), solver, judge)).toEqual({
    refusal:
      "The task's sandbox reads OPENAI_API_KEY, which the model being tested also uses: a judge in the sandbox cannot share it",
  });
  const apart = judgeTrial(hostVariables(tau3), { PATH: "/usr/bin" }, judge);
  if ("refusal" in apart) throw new Error(apart.refusal);
  expect(apart.child).toMatchObject({
    OPENAI_API_KEY: "trial-key",
    OPENAI_BASE_URL: connection.openAiBase,
  });

  // A defaulted variable takes its default, even when the worker holds one by that name: the
  // verifier's is set to the default outright, and the sandbox's is refused.
  const pinned = judgeTrial(hostVariables(harvey), { JUDGE_CONCURRENCY: "64" }, judge);
  if ("refusal" in pinned) throw new Error(pinned.refusal);
  expect(pinned.verifierEnv).toContain("JUDGE_CONCURRENCY=8");
  expect(judgeTrial(hostVariables(tau3), { TAU2_USER_MODEL: "worker" }, judge)).toEqual({
    refusal: "The task reads TAU2_USER_MODEL from the worker",
  });
  expect(judgeTrial(hostVariables(harvey), {}, {})).toEqual({
    refusal: "The task's judge needs ANTHROPIC_API_KEY: select a judge credential",
  });
});

test("a trial names its judge credential for the gateway, and never reads its key", async () => {
  const vault = memoryVault();
  const judgeKey = await vault.credentials.create(
    1,
    { name: "Judge", kind: "anthropic", auth: "api-key", value: "judge-secret" },
    {},
  );
  const input = await credentialedInput(vault, (draft) => {
    if (draft.credentials) draft.credentials.judgeCredentialId = judgeKey.id;
  });
  const execution = await credentialExecution(input, "/home", { PATH: "/bin" }, vault);
  expect(execution.judge).toEqual({ credentialId: judgeKey.id, provider: "anthropic" });
  expect(JSON.stringify(execution)).not.toContain("judge-secret");
  const signIn = await vault.credentials.create(
    1,
    { name: "Claude", kind: "anthropic", auth: "claude-login", value: "sk-ant-oat01-token" },
    {},
  );
  const refused = await credentialedInput(vault, (draft) => {
    if (draft.credentials) draft.credentials.judgeCredentialId = signIn.id;
  });
  await expect(credentialExecution(refused, "/home", {}, vault)).rejects.toThrow(
    "Judge credential unavailable",
  );
});
