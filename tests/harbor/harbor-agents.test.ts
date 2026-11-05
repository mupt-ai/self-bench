import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/lib/process.js";

const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** The runtime modules as Harbor's PYTHONPATH sees them, with the capture the build copies in. */
async function packedRuntime(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "selfbench-harbor-agents-"));
  for (const name of ["harbor_agents.py", "harbor_dari.py", "harbor_gateway.py"])
    await copyFile(join(runtime, name), join(directory, name));
  await writeFile(join(directory, "dari_capture.cjs"), "module.exports = {};\n");
  return directory;
}

/** Harbor's agents, as far as SelfBench's use them: Pi's run command, and an install. */
const HARBOR = `import asyncio, json, os, shlex, subprocess, sys, tempfile, types
sys.path.insert(0, sys.argv[1])
class Pi:
    def __init__(self, failures=0, model_details=None):
        self.commands, self.failures, self.installs = [], failures, 0
        self.options = types.SimpleNamespace(model_details=model_details)
    def _build_custom_models_json(self, access, model_id):
        # Harbor's custom endpoint entry, when the trial names one (OPENAI_BASE_URL).
        if access is None:
            return None
        return {"providers": {"harbor-endpoint": {"baseUrl": access, "models": [{"id": model_id}]}}}
    def render_instruction(self, instruction):
        return instruction
    async def run(self, instruction, environment, context):
        # Harbor's command (harbor/agents/installed/pi.py).
        await self.exec_as_agent(environment, command=(
            ". ~/.nvm/nvm.sh; pi --print --mode json --session-dir /logs/agent/pi/sessions "
            f"--provider p --model m {shlex.quote(self.render_instruction(instruction))} "
            "2>&1 </dev/null | grep -v '\\"type\\":\\"message_update\\"' | stdbuf -oL tee /logs/agent/pi.txt"))
    async def exec_as_agent(self, environment, command, **kwargs):
        self.commands.append(command)
    async def install(self, environment):
        self.installs += 1
        if self.installs <= self.failures:
            raise RuntimeError("curl: (56) OpenSSL SSL_read: decryption failed or bad record mac")
sys.modules["harbor.agents.installed.pi"] = types.SimpleNamespace(Pi=Pi, PiOptions=object)
sys.modules["harbor.agents.installed.codex"] = types.SimpleNamespace(Codex=object)
sys.modules["harbor.agents.installed.claude_code"] = types.SimpleNamespace(ClaudeCode=object)
INSTRUCTION = "- Update the \`display\` style property to accept \\"grid\\".\\n- It's done when tests pass."
def prompt(command):
    """Pi's arguments in a Harbor run command."""
    return shlex.split(command.split("; ", 1)[1].split(" 2>&1 ", 1)[0])
`;

async function python(script: string) {
  const result = await runCommand("python3", ["-c", `${HARBOR}${script}`, await packedRuntime()]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
}

test("Pi reads an instruction written as a list as its prompt, not as an option", async () => {
  await python(`
import harbor_dari
agent = harbor_dari.DariPi()
asyncio.run(agent.run(INSTRUCTION, None, None))
capture, start = agent.commands
assert capture.startswith("mkdir -p /logs/agent && printf %s "), capture
pi = prompt(start)
assert pi[-2:] == ["--", INSTRUCTION], pi
assert pi[:6] == ["pi", "--print", "--mode", "json", "--extension", "/logs/agent/dari_capture.cjs"], pi
# Other commands pass unchanged, including ones that mention the instruction's text.
asyncio.run(agent.exec_as_agent(None, "echo " + shlex.quote(INSTRUCTION)))
assert agent.commands[-1] == "echo " + shlex.quote(INSTRUCTION)
`);
});

test("gateway Pi adds the model's details to Harbor's models.json for the gateway", async () => {
  await python(`
import harbor_gateway as adapter
assert adapter.GatewayPi.options_model is adapter.GatewayPiOptions
details = {"name": "GPT-6 Sol", "input": ["text", "image"], "contextWindow": 272000, "maxTokens": 128000}
agent = adapter.GatewayPi(model_details=details)
models = agent._build_custom_models_json("https://gateway.example/v1", "dari/model/openai/gpt-6-sol")
assert models == {"providers": {"harbor-endpoint": {"baseUrl": "https://gateway.example/v1",
    "models": [{"id": "dari/model/openai/gpt-6-sol", **details}]}}}, models
# A model no catalog describes keeps Harbor's entry.
assert adapter.GatewayPi()._build_custom_models_json("u", "m")["providers"]["harbor-endpoint"]["models"] == [{"id": "m"}]
asyncio.run(agent.run(INSTRUCTION, None, None))
assert prompt(agent.commands[-1])[-2:] == ["--", INSTRUCTION], agent.commands
# Without the gateway as its endpoint, Pi would call a provider directly: refuse instead.
try:
    agent._build_custom_models_json(None, "m")
    raise SystemExit("ran without the gateway")
except ValueError:
    pass
`);
});

test("an agent install that fails is tried again, up to three times", async () => {
  await python(`
import harbor_agents, harbor_dari
waits = []
async def wait(seconds):
    waits.append(seconds)
harbor_agents.asyncio = types.SimpleNamespace(sleep=wait)
agent = harbor_dari.DariPi(failures=2)
asyncio.run(agent.install(None))
assert agent.installs == 3 and waits == [10, 20], (agent.installs, waits)
agent = harbor_dari.DariPi(failures=3)
try:
    asyncio.run(agent.install(None))
    raise SystemExit("installed after three failures")
except RuntimeError as error:
    assert "decryption failed" in str(error)
assert agent.installs == 3
`);
});
