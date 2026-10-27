import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { gatewayTrial } from "../src/evaluation/gateway-trial.js";
import { solverArguments } from "../src/evaluation/solver-arguments.js";
import { getEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import type { runCommand } from "../src/lib/process.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

test.each([
  [
    "openai",
    "codex-login",
    "codex",
    { CODEX_AUTH_JSON_PATH: "/private/auth.json" },
    ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"],
  ],
  [
    "anthropic",
    "claude-login",
    "claude-code",
    { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
    ["api.anthropic.com"],
  ],
  ["meta", "muse-login", "muse-code", {}, ["api.meta.ai"]],
  // Muse Code keeps a Meta key on Meta's own host.
  ["meta", "api-key", "muse-code", { META_API_KEY: "test-key" }, ["api.meta.ai"]],
  [
    "dari",
    "api-key",
    "pi",
    { OPENAI_BASE_URL: "https://router.dari.test/v1" },
    ["router.dari.test"],
  ],
] as const)(
  "a direct %s %s trial grants only its vendor's hosts",
  (provider, auth, harness, env, hosts) => {
    const input = {
      modelName: provider === "dari" ? "dari/routing" : `${provider}/model`,
      credentials: { provider, auth },
    } as EvaluationInput;
    const trial = gatewayTrial(input, harness, input.modelName, env);
    expect(trial.extraAllowedHosts).toEqual([...hosts]);
    const args = solverArguments("task", "jobs", trial, "modal", trial.extraAllowedHosts);
    expect(
      args.flatMap((arg, index) => (arg === "--allow-agent-host" ? [args[index + 1]] : [])),
    ).toEqual([...hosts]);
  },
);

test("a historical bundle is backfilled for execution without changing the stored artifact", async () => {
  const { store, input, vault } = await runnerFixture(
    '[agent]\nnetwork_mode = "allowlist"\nallowed_hosts = ["openai.com", "*.openai.com", "chatgpt.com", "*.chatgpt.com"]\n[environment]\nnetwork_mode = "public"\n[verifier]\nnetwork_mode = "public"\n',
  );
  const key = input.tasks[0]?.bundleKey ?? "";
  const before = await store.getByKey(key);
  let solved = false;
  // An OpenAI key's agent reaches only the gateway, whatever hosts the old bundle granted.
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const taskPath = args[args.indexOf("--path") + 1];
    const prepared = parse(await readFile(join(taskPath ?? "", "task.toml"), "utf8"));
    expect(prepared.agent).toMatchObject({ network_mode: "allowlist", allowed_hosts: [] });
    expect(prepared.environment).toEqual({ network_mode: "public" });
    expect(prepared.verifier).toEqual({ network_mode: "public" });
    expect(
      args.flatMap((arg, index) => (arg === "--allow-agent-host" ? [args[index + 1]] : [])),
    ).toEqual(["api.selfbench.test"]);
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
  expect((await getEvaluation(store, input, input.id))?.status).toBe("completed");
  expect(await store.getByKey(key)).toEqual(before);
});
