import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trialCost } from "../../src/evaluation/cost.js";
import { initialEvaluation } from "../../src/evaluation/store.js";
import { transcriptSteps } from "../../src/evaluation/transcript.js";
import { runCommand } from "../../src/lib/process.js";
import { evaluationInput } from "../support/evaluation-fixture.js";

const adapter = fileURLToPath(
  new URL("../../src/harnesses/harbor/runtime/harbor_muse.py", import.meta.url),
);

/** Harbor's modules, as far as the adapter uses them, so the test needs no Harbor install. */
const STUBS = `import asyncio, importlib.util, json, os, sys, types, typing
from pathlib import Path
sys.modules["pydantic"] = types.SimpleNamespace(Field=lambda **kwargs: None)
sys.modules["harbor.agents.options"] = types.SimpleNamespace(Cli=lambda *args, **kwargs: None)
sys.modules["harbor.models.trial.paths"] = types.SimpleNamespace(
    EnvironmentPaths=types.SimpleNamespace(agent_dir=Path("/logs/agent")))
sys.modules["harbor.agents.installed.base"] = types.SimpleNamespace(
    with_prompt_template=lambda fn: fn)
muse = types.ModuleType("harbor.agents.installed.muse_code")
class MuseCode:
    def __init__(self, env, logs_dir=None):
        self.env, self.logs_dir, self.model_name, self.calls = env, logs_dir, "meta/muse-spark-1.3", []
    def _get_env(self, key):
        return self.env.get(key)
    def name(self):
        return "muse-code"
    def version(self):
        return "1.4.6"
    def build_cli_flags(self):
        return "--reasoning-effort high"
    def _build_run_command(self, instruction):
        return "muse exec " + self.build_cli_flags() + " " + instruction
    async def _upload_agent_owned_file(self, environment, source, target):
        self.calls.append(("upload", str(source), target))
    async def exec_as_agent(self, environment, command, env=None):
        self.calls.append(("exec", command, env))
    async def run(self, instruction, environment, context):
        self.calls.append(("harbor run", instruction))
muse.MuseCode, muse.MuseCodeOptions = MuseCode, type("MuseCodeOptions", (), {})
sys.modules[muse.__name__] = muse
spec = importlib.util.spec_from_file_location("harbor_muse", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
`;

const python = (script: string, ...args: string[]) =>
  runCommand("python3", ["-c", STUBS + script, adapter, ...args]);

test("Muse Code signs in from its own auth.json, never Meta's API key, with contributor mode and web tools off", async () => {
  const result = await python(`
async def check():
    agent = adapter.SelfBenchMuseCode({"MUSE_AUTH_JSON_PATH": "/host/muse-auth.json"})
    # Harbor's own options stop short of max, which Muse Spark 1.3 and Muse Wonder take.
    levels, _ = typing.get_args(typing.get_args(adapter.SelfBenchMuseCodeOptions.__annotations__["reasoning_effort"])[0])
    assert typing.get_args(levels) == ("none", "minimal", "low", "medium", "high", "xhigh", "max")
    assert agent.build_cli_flags() == "--reasoning-effort high --contributor-mode off --disable-web-tools"
    await agent.run("solve it", None, None)
    upload, install, run, copy = agent.calls
    assert upload == ("upload", "/host/muse-auth.json", "/tmp/selfbench-muse-auth.json")
    assert install[1].endswith('mv /tmp/selfbench-muse-auth.json "$dir/auth.json" && chmod 600 "$dir/auth.json"')
    assert run[1].startswith("muse exec ") and run[1].endswith("--disable-web-tools solve it")
    assert run[2] == {"MUSE_NO_AUTO_UPDATE": "1"}
    assert "/logs/agent/sessions" in copy[1]
    keyed = adapter.SelfBenchMuseCode({"META_API_KEY": "key"})
    await keyed.run("solve it", None, None)
    assert keyed.calls == [("harbor run", "solve it")]
asyncio.run(check())
`);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

/** A Muse session log as Muse Code writes it, records wrapped in a transaction included. */
function sessionLog(): string {
  const run = (event: object) => ({
    record_type: "event",
    payload_type: "runtime.session",
    payload: { kind: "run", run_id: "run-1", event },
  });
  const usage = (input: number, output: number, cached: number) => ({
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cached,
    cache_write_tokens: 0,
    cache_read_tokens: cached,
    reasoning_tokens: 10,
  });
  const records = [
    {
      record_type: "event",
      payload_type: "runtime.user_intent.accepted",
      payload: { refill_blocks: [{ kind: "text", text: "Count the lines in a.txt." }] },
    },
    run({ kind: "model_response_created", response_id: "resp-1" }),
    run({ kind: "reasoning_committed", response_id: "resp-1", text: "" }),
    run({ kind: "assistant_message_committed", response_id: "resp-1", text: "Counting." }),
    run({ kind: "model_completed", usage: usage(29_701, 187, 0), model: "muse-spark-1.3" }),
    run({
      kind: "assistant_tool_calls_committed",
      response_id: "resp-1",
      tool_calls: [{ call_id: "call-1", name: "bash", args: '{"command":"wc -l a.txt"}' }],
    }),
    run({ kind: "tool_result_batch_committed", results: [{ tool_call_id: "call-1", text: "1" }] }),
    run({ kind: "model_response_created", response_id: "resp-2" }),
    run({ kind: "assistant_message_committed", response_id: "resp-2", text: "1" }),
    run({ kind: "model_completed", usage: usage(30_038, 94, 29_425), model: "muse-spark-1.3" }),
  ];
  const [first, ...rest] = records;
  return [
    JSON.stringify({ retained_frame: "tx", children: [{ record_json: JSON.stringify(first) }] }),
    ...rest.map((record) => JSON.stringify(record)),
    "not json",
  ].join("\n");
}

test("a Muse session becomes Harbor's trajectory, priced at Meta's list rates and shown as steps", async () => {
  const logs = await mkdtemp(join(tmpdir(), "muse-logs-"));
  try {
    const session = join(logs, "sessions/2026/10/12/session-1");
    await mkdir(join(session, "subagent/verify"), { recursive: true });
    await writeFile(join(session, "session.jsonl"), sessionLog());
    // Muse's verify reminder: a request of its own in a subagent's log.
    await writeFile(
      join(session, "subagent/verify/session.jsonl"),
      JSON.stringify({
        payload_type: "runtime.session",
        payload: {
          kind: "run",
          event: {
            kind: "model_completed",
            model: "muse-spark-1.3",
            usage: { input_tokens: 3_720, output_tokens: 970, cache_read_tokens: 0 },
          },
        },
      }),
    );
    const result = await python(
      `
context = types.SimpleNamespace()
adapter.SelfBenchMuseCode({}, Path(sys.argv[2])).populate_context_post_run(context)
print(json.dumps(vars(context)))
`,
      logs,
    );
    expect(result.stderr).toBe("");
    const totals = JSON.parse(result.stdout);
    expect(totals).toEqual({
      n_input_tokens: 29_701 + 30_038 + 3_720,
      n_cache_tokens: 29_425,
      n_output_tokens: 187 + 94 + 970,
    });
    const trajectory = await readFile(join(logs, "trajectory.json"), "utf8");
    const files = new Map([["solver/t/agent/trajectory.json", trajectory]]);
    expect(transcriptSteps(files)).toEqual([
      { id: "1", role: "user", text: "Count the lines in a.txt.", tools: [] },
      {
        id: "2",
        role: "agent",
        text: "Counting.",
        tools: [
          { id: "call-1", name: "bash", input: '{\n  "command": "wc -l a.txt"\n}', output: "1" },
        ],
      },
      { id: "3", role: "agent", text: "1", tools: [] },
    ]);
    const pricing = {
      input: 1.25,
      output: 4.25,
      cacheRead: 0.15,
      cacheWrite: 1.25,
      source: "https://dev.meta.ai/docs/pricing-rate-limits",
      asOf: "2026-09-23",
    };
    const run = initialEvaluation(
      { ...evaluationInput(), modelName: "meta/muse-spark-1.3", pricing },
      "Test",
    );
    const cost = trialCost(run, "muse-code", files, { agent_result: totals });
    expect(cost).toMatchObject({
      modelVerified: true,
      tokenUsage: { input: 29_701 + 613 + 3_720, output: 1_251, cacheRead: 29_425, cacheWrite: 0 },
      costSource: "reference-rates",
    });
    expect(cost.apiCostUsd).toBeCloseTo(
      ((29_701 + 613 + 3_720) * 1.25 + 1_251 * 4.25 + 29_425 * 0.15) / 1e6,
      10,
    );
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
});
