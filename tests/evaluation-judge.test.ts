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

test("each kind of API key provides the judge variables its provider answers", () => {
  const key = (kind: string) => ({ kind, auth: "api-key" }) as const;
  expect(judgeEnvironment(key("openai") as never, "sk-1")).toEqual({
    OPENAI_API_KEY: "sk-1",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_API_BASE: "https://api.openai.com/v1",
  });
  expect(judgeEnvironment(key("anthropic") as never, "sk-2")).toEqual({
    ANTHROPIC_API_KEY: "sk-2",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  });
  expect(Object.keys(judgeEnvironment(key("openrouter") as never, "sk-3")).sort()).toEqual([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_BASE",
    "OPENROUTER_API_KEY",
  ]);
  expect(
    judgeEnvironment(
      { kind: "custom", auth: "api-key", endpoint: "https://router.example/v1" },
      "sk-4",
    ).OPENAI_BASE_URL,
  ).toBe("https://router.example/v1");
  // A subscription sign-in drives only its own CLI, never a judge.
  expect(judgeEnvironment({ kind: "anthropic", auth: "claude-login" }, "token")).toEqual({});
  const anthropic = { variables: ["ANTHROPIC_API_KEY"], required: ["ANTHROPIC_API_KEY"] };
  expect(judgeCredentialRefusal(key("openai") as never, anthropic)).toBe(
    "The judge credential can't provide ANTHROPIC_API_KEY; select an API key for that provider or a gateway",
  );
  expect(judgeCredentialRefusal(key("vercel-ai-gateway") as never, anthropic)).toBeUndefined();
  expect(
    judgeCredentialRefusal(key("openai") as never, {
      variables: ["ANTHROPIC_API_KEY"],
      required: [],
    }),
  ).toBe("The judge credential can't provide any of ANTHROPIC_API_KEY");
});

test("a trial gives the judge its key without touching the solver's own", () => {
  const judge = judgeEnvironment({ kind: "anthropic", auth: "api-key" }, "judge-key");
  const solver = { PATH: "/usr/bin", OPENAI_API_KEY: "solver-key" };
  // The verifier gets the key by --verifier-env, as a template the run's environment answers.
  const graded = judgeTrial(hostVariables(harvey), solver, judge);
  if ("refusal" in graded) throw new Error(graded.refusal);
  expect(graded.verifierEnv).toEqual([`ANTHROPIC_API_KEY=\${SELFBENCH_JUDGE_ANTHROPIC_API_KEY}`]);
  expect(graded.child).toEqual({ ...solver, SELFBENCH_JUDGE_ANTHROPIC_API_KEY: "judge-key" });
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

  // A sandbox variable is Harbor's own environment, which the solver may share only if they agree.
  const openAi = judgeEnvironment({ kind: "openai", auth: "api-key" }, "judge-key");
  const clash = judgeTrial(hostVariables(tau3), solver, openAi);
  expect(clash).toEqual({
    refusal:
      "The task's sandbox reads OPENAI_API_KEY, which the model being tested also uses: pick the same credential for the judge",
  });
  const shared = judgeTrial(hostVariables(tau3), { OPENAI_API_KEY: "judge-key" }, openAi);
  if ("refusal" in shared) throw new Error(shared.refusal);
  expect(shared.child.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");

  // A defaulted variable takes its default, even when the worker holds one by that name: the
  // verifier's is set to the default outright, and the sandbox's is refused.
  const pinned = judgeTrial(hostVariables(harvey), { JUDGE_CONCURRENCY: "64" }, judge);
  if ("refusal" in pinned) throw new Error(pinned.refusal);
  expect(pinned.verifierEnv).toContain("JUDGE_CONCURRENCY=8");
  expect(judgeTrial(hostVariables(tau3), { TAU2_USER_MODEL: "worker" }, openAi as never)).toEqual({
    refusal: "The task reads TAU2_USER_MODEL from the worker",
  });
  // An optional judge key the judge credential lacks never falls through to the solver's own key.
  const optional = {
    verifier: { env: { OPENAI_API_KEY: `\${OPENAI_API_KEY:-}`, KEY: `\${ANTHROPIC_API_KEY}` } },
  };
  const separate = judgeTrial(hostVariables(optional), solver, judge);
  if ("refusal" in separate) throw new Error(separate.refusal);
  expect(separate.verifierEnv).toContain("OPENAI_API_KEY=");
  expect(separate.child.OPENAI_API_KEY).toBe("solver-key");
  expect(judgeTrial(hostVariables(harvey), {}, {})).toEqual({
    refusal: "The task's judge needs ANTHROPIC_API_KEY: select a judge credential",
  });
});

test("a trial resolves the judge's key from its judge credential, apart from the solver's", async () => {
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
  expect(execution.judge).toEqual({
    ANTHROPIC_API_KEY: "judge-secret",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  });
  // The judge's key is redacted from output like the solver's, and stays out of its environment.
  expect(execution.secrets).toContain("judge-secret");
  expect(execution.child.ANTHROPIC_API_KEY).toBeUndefined();
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
