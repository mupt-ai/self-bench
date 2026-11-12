import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { readTrialKey } from "../src/gateway/trial-key.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import type { runCommand } from "../src/lib/process.js";
import { TEST_GATEWAY_API, testGateway } from "./support/evaluation-gateway.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

// A run with a subagent model through the runner: the trial's key and adapter name both models,
// and what the trial used and cost comes from the gateway's records alone.

const DEEPSEEK = "openrouter/deepseek/deepseek-v4-pro-0813";
const subagent = {
  catalogId: "deepseek-v4-pro-0813",
  model: DEEPSEEK,
  label: "DeepSeek V4 Pro",
  credentialId: "managed-model",
  thinking: "high",
} as const;
const mixed = (input: EvaluationInput) => {
  input.subagent = subagent;
};

/**
 * Harbor's part of a trial: a passing result, and a Codex trajectory that prices the whole trial
 * at the run's own model, as Harbor does. Its figures are not the trial's: Harbor converted one
 * session, and reports $99 for it.
 */
function harbor(seen: { env?: NodeJS.ProcessEnv; args?: string[] } = {}): typeof runCommand {
  return async (_name, args, options) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    Object.assign(seen, { env: options?.env, args });
    const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
    await mkdir(join(trial, "agent"), { recursive: true });
    await writeFile(
      join(trial, "agent", "trajectory.json"),
      JSON.stringify({
        agent: { model_name: "dari/model/openai/test-model" },
        steps: [
          {
            step_id: 1,
            source: "agent",
            message: "Delegated the parser fix",
            model_name: "dari/model/openai/test-model",
            metrics: { prompt_tokens: 900, completion_tokens: 90, cached_tokens: 0, cost_usd: 99 },
          },
        ],
        final_metrics: { extra: { total_cache_write_input_tokens: 0 } },
      }),
    );
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({
        agent_result: { n_input_tokens: 900, n_output_tokens: 90, n_cache_tokens: 0, cost_usd: 99 },
        verifier_result: { rewards: { reward: 1 } },
        exception_info: null,
      }),
    );
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

/** What the gateway recorded of the trial's calls: three on the run's model, two on DeepSeek. */
const deepseek = { model: DEEPSEEK, calls: 2, input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
const calls = [
  { model: "openai/test-model", calls: 3, input: 100, output: 20, cacheRead: 50, cacheWrite: 5 },
  deepseek,
];

test("a trial with a subagent model is measured by the gateway's records of both models", async () => {
  const { store, input, vault } = await runnerFixture(undefined, mixed);
  const seen: { env?: NodeJS.ProcessEnv; args?: string[] } = {};
  const tag = `${input.id}/0`;
  const gateway = testGateway({ [tag]: { costUsd: 1.75, complete: true } }, { [tag]: calls });
  await runEvaluation(store, input, { env: {}, vault, command: harbor(seen), gateway });
  // The trial's key serves the run's model and the subagent model, pinned to its level, and the
  // adapter is told which model its subagents ask for.
  expect(readTrialKey(seen.env?.OPENAI_API_KEY ?? "", TEST_GATEWAY_API.secret)).toMatchObject({
    model: "openai/test-model",
    subagent: { model: DEEPSEEK, credentialId: "managed-model", thinking: "high" },
  });
  expect(seen.args).toContain(`subagent_model=dari/model/${DEEPSEEK}`);
  const trial = (await getEvaluation(store, input, input.id))?.trials[0];
  expect(trial).toMatchObject({
    status: "completed",
    // The gateway's total for both models, not Harbor's $99 or the run's rates on its tokens.
    apiCostUsd: 1.75,
    billedCostUsd: 1.75,
    costSource: "gateway",
    modelVerified: true,
    tokenUsage: { input: 140, output: 30, cacheRead: 50, cacheWrite: 5 },
    subagentCalls: 2,
  });
  expect(trial?.steps.map((step) => step.text)).toEqual(["Delegated the parser fix"]);
});

test("a trial with a subagent model has no cost when the gateway could not price a call", async () => {
  const { store, input, vault } = await runnerFixture(undefined, mixed);
  const tag = `${input.id}/0`;
  const gateway = testGateway({ [tag]: { costUsd: 1.2, complete: false } }, { [tag]: calls });
  await runEvaluation(store, input, { env: {}, vault, command: harbor(), gateway });
  const trial = (await getEvaluation(store, input, input.id))?.trials[0];
  // Unknown rather than estimated: the transcript could price the trial at the run's rates.
  expect(trial).toMatchObject({ status: "completed", modelVerified: true, subagentCalls: 2 });
  expect(trial).not.toHaveProperty("apiCostUsd");
  expect(trial).not.toHaveProperty("billedCostUsd");
  expect(trial).not.toHaveProperty("costSource");
});

test("a trial whose agent never delegated says so, and one the gateway never saw is unverified", async () => {
  const own = calls.slice(0, 1);
  for (const [recorded, expected] of [
    [own, { modelVerified: true, subagentCalls: 0 }],
    // Only the subagent model answered: the run's own model never ran.
    [calls.slice(1), { modelVerified: false, subagentCalls: 2 }],
    // A model the key does not name cannot be served; if one were recorded, it is not verified.
    [[...calls, { ...deepseek, model: "openrouter/other/model" }], { modelVerified: false }],
  ] as const) {
    const { store, input, vault } = await runnerFixture(undefined, mixed);
    const tag = `${input.id}/0`;
    const gateway = testGateway(
      { [tag]: { costUsd: 1, complete: true } },
      { [tag]: [...recorded] },
    );
    await runEvaluation(store, input, { env: {}, vault, command: harbor(), gateway });
    expect((await getEvaluation(store, input, input.id))?.trials[0]).toMatchObject(expected);
  }
  const { store, input, vault } = await runnerFixture(undefined, mixed);
  await runEvaluation(store, input, { env: {}, vault, command: harbor(), gateway: testGateway() });
  const unseen = (await getEvaluation(store, input, input.id))?.trials[0];
  expect(unseen?.status).toBe("completed");
  for (const field of ["modelVerified", "tokenUsage", "apiCostUsd", "subagentCalls"])
    expect(unseen).not.toHaveProperty(field);
});

test("a trial is refused before its solver starts when its subagent model cannot be served", async () => {
  const refused = async (change: (input: EvaluationInput) => void) => {
    const { store, input, vault } = await runnerFixture(undefined, (input) => {
      mixed(input);
      change(input);
    });
    let started = false;
    const command: typeof runCommand = async (_name, args) => {
      if (args[0] !== "--version") started = true;
      return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    };
    await runEvaluation(store, input, { env: {}, vault, command });
    expect(started).toBe(false);
    return (await getEvaluation(store, input, input.id))?.trials[0];
  };
  // A credential the workspace no longer has.
  expect(
    await refused((input) => {
      input.subagent = { ...subagent, credentialId: crypto.randomUUID() };
    }),
  ).toMatchObject({ status: "failed", error: "Subagent model credential unavailable" });
  // A harness with no subagent model setting.
  expect(
    await refused((input) => {
      input.harnesses = ["pi"];
    }),
  ).toMatchObject({ status: "failed", error: expect.stringContaining("Pi takes no subagent") });
});
