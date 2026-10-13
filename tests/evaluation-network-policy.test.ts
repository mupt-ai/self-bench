import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { gatewayTrial } from "../src/evaluation/execution.js";
import { solverArguments } from "../src/evaluation/solver-arguments.js";
import { getEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import type { runCommand } from "../src/lib/process.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

test.each([
  ["openai", {}, ["api.openai.com"]],
  [
    "openai",
    { CODEX_AUTH_JSON_PATH: "/private/auth.json" },
    ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"],
  ],
  ["anthropic", {}, ["api.anthropic.com"]],
  ["anthropic", { CLAUDE_CODE_OAUTH_TOKEN: "test-token" }, ["api.anthropic.com"]],
  ["meta", {}, ["api.meta.ai"]],
  ["custom", { OPENAI_BASE_URL: "https://models.example/v1" }, ["models.example"]],
  [
    "openai",
    { OPENAI_BASE_URL: "https://models.example/v1", OPENAI_API_BASE: "https://models.example/v1" },
    ["models.example"],
  ],
] as const)("%s grants only its connection's hosts: %j", (provider, env, hosts) => {
  const input = { credentials: { provider } } as EvaluationInput;
  const trial = gatewayTrial(input, "codex", "openai/model", env);
  expect(trial.extraAllowedHosts).toEqual([...hosts]);
  const args = solverArguments(
    "task",
    "jobs",
    "codex",
    trial.model,
    "modal",
    undefined,
    trial.extraAllowedHosts,
    undefined,
    provider,
  );
  expect(
    args.flatMap((arg, index) => (arg === "--allow-agent-host" ? [args[index + 1]] : [])),
  ).toEqual([...hosts]);
});

test("a historical bundle is backfilled for execution without changing the stored artifact", async () => {
  const { store, input, vault } = await runnerFixture(
    '[agent]\nnetwork_mode = "allowlist"\nallowed_hosts = ["openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com"]\n[environment]\nnetwork_mode = "public"\n[verifier]\nnetwork_mode = "public"\n',
  );
  const key = input.tasks[0]?.bundleKey ?? "";
  const before = await store.getByKey(key);
  let solved = false;
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const taskPath = args[args.indexOf("--path") + 1];
    const prepared = parse(await readFile(join(taskPath ?? "", "task.toml"), "utf8"));
    expect(prepared.agent).toMatchObject({ network_mode: "allowlist", allowed_hosts: [] });
    expect(prepared.environment).toEqual({ network_mode: "public" });
    expect(prepared.verifier).toEqual({ network_mode: "public" });
    expect(
      args.flatMap((arg, index) => (arg === "--allow-agent-host" ? [args[index + 1]] : [])),
    ).toEqual(["api.openai.com"]);
    const jobs = args[args.indexOf("--jobs-dir") + 1];
    const trial = join(jobs ?? "", "solver", "task__123");
    await mkdir(trial, { recursive: true });
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({ verifier_result: { rewards: { reward: 1 } }, exception_info: null }),
    );
    solved = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  await runEvaluation(store, input, { env: {}, vault, command });
  expect(solved).toBe(true);
  expect((await getEvaluation(store, input.repoId, input.id))?.status).toBe("completed");
  expect(await store.getByKey(key)).toEqual(before);
});
