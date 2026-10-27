import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  gatewayModelId,
  gatewayTrial,
  pinnedThinking,
  trialRoute,
} from "../src/evaluation/gateway-trial.js";
import { harnessIds } from "../src/evaluation/models.js";
import { solverArguments } from "../src/evaluation/solver-arguments.js";
import type { EvaluationInput, Harness } from "../src/evaluation/types.js";
import { gatewayConnection } from "../src/gateway/connection.js";
import { readTrialKey } from "../src/gateway/trial-key.js";
import { runCommand } from "../src/lib/process.js";

const SECRET = "s".repeat(40);
const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const ADAPTER = fileURLToPath(
  new URL("../src/harnesses/harbor/runtime/harbor_gateway.py", import.meta.url),
);

/** Harbor's agent modules, stubbed so harbor_gateway.py loads without Harbor installed. */
const HARBOR_STUBS = `import sys, types
pi = types.ModuleType("harbor.agents.installed.pi")
pi.Pi = type("Pi", (), {})
pi.PiOptions = type("PiOptions", (), {})
sys.modules[pi.__name__] = pi
sys.modules["harbor.agents.model_connection"] = types.SimpleNamespace(ModelConnectionSpec=lambda **kwargs: kwargs)
`;

function input(provider: string, modelName: string, thinking?: string): EvaluationInput {
  return {
    modelName,
    ...(thinking ? { thinking } : {}),
    credentials: { provider, auth: "api-key", modelCredentialId: CREDENTIAL },
  } as EvaluationInput;
}

function connect(trialInput: EvaluationInput, harness: Harness) {
  const thinking = pinnedThinking(harness, trialInput.thinking);
  return gatewayConnection({
    apiUrl: "https://api.selfbench.test",
    secret: SECRET,
    orgId: 7,
    credentialId: CREDENTIAL,
    model: gatewayModelId(trialInput),
    ...(thinking ? { thinking } : {}),
    tags: { run: "r1", trial: "r1/0", harness },
  });
}

test("Codex keeps the gateway's full model id and speaks HTTPS to it", async () => {
  expect(
    solverArguments(
      "task",
      "jobs",
      { agent: "harbor_gateway:SelfBenchCodex", model: "openai/gpt-6-sol", agentArguments: [] },
      "modal",
    ),
  ).toContain("harbor_gateway:SelfBenchCodex");
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, os, subprocess, sys, types
${HARBOR_STUBS}
module = types.ModuleType("harbor.agents.installed.codex")
class Codex:
    def _build_effective_config(self, openai_base_url=None):
        return {"openai_base_url": openai_base_url} if openai_base_url else {}
    async def exec_as_agent(self, environment, command, **kwargs):
        return command, kwargs
module.Codex = Codex
sys.modules[module.__name__] = module
sys.modules["harbor.agents.installed.claude_code"] = types.SimpleNamespace(ClaudeCode=object)
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
async def check():
    command, options = await adapter.SelfBenchCodex().exec_as_agent(None, 'printf %s "$NVM_DIR"', timeout_sec=30)
    output = subprocess.check_output(["bash", "-c", command], env={**os.environ, "HOME": "/root", "NVM_DIR": "/usr/local/share/nvm"}, text=True)
    assert output == "/root/.nvm"
    assert options == {"timeout_sec": 30}
    gateway = adapter.GatewayCodex()
    # Harbor's Codex keeps only the last segment; the gateway serves dari/model/<provider>/<model>.
    gateway.model_name = "openai/dari/model/openrouter/anthropic/claude-sonnet-5"
    command, _ = await gateway.exec_as_agent(None, "codex exec --model claude-sonnet-5 --json")
    assert "--model dari/model/openrouter/anthropic/claude-sonnet-5 " in command, command
    assert command.startswith('export NVM_DIR="$HOME/.nvm"; ')
    gateway.model_name = "openai/dari/routing"
    command, _ = await gateway.exec_as_agent(None, "codex exec --model routing --json")
    assert "--model dari/routing " in command
    config = gateway._build_effective_config("https://gateway.example/v1")
    assert "openai_base_url" not in config
    assert config["model_providers"][config["model_provider"]] == {
        "name": "Gateway", "base_url": "https://gateway.example/v1", "env_key": "OPENAI_API_KEY",
        "wire_api": "responses", "supports_websockets": False}
asyncio.run(check())
`,
    ADAPTER,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("Codex and Claude Code install without system Node on non-Alpine images", async () => {
  expect(
    solverArguments(
      "task",
      "jobs",
      {
        agent: "harbor_gateway:SelfBenchClaudeCode",
        model: "anthropic/claude-opus-5-5",
        agentArguments: [],
      },
      "modal",
    ),
  ).toContain("harbor_gateway:SelfBenchClaudeCode");
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, sys, types
${HARBOR_STUBS}
module = types.ModuleType("harbor.agents.installed.claude_code")
class ClaudeCode:
    def __init__(self, manager):
        self.manager, self.root, self.installed, self.ensured = manager, [], False, None
    async def exec_as_root(self, environment, command):
        self.root.append(command)
    async def _get_system_package_manager(self, environment):
        return self.manager
    async def install(self, environment):
        self.installed = True
    async def ensure_system_dependencies(self, environment, dependencies):
        self.ensured = dependencies
module.ClaudeCode = ClaudeCode
sys.modules[module.__name__] = module
sys.modules["harbor.agents.installed.codex"] = types.SimpleNamespace(Codex=ClaudeCode)
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
DEPENDENCIES = ("curl", "bash", "nodejs", "npm", "procps")
async def check():
    agent = adapter.SelfBenchClaudeCode("apt-get")
    await agent.install(types.SimpleNamespace(default_user="agent"))
    assert agent.installed
    assert agent.root == ['home="$(getent passwd agent | cut -d: -f6)"; if [ -n "$home" ]; then mkdir -p "$home/.cache" && chown agent "$home/.cache"; fi']
    await agent.ensure_system_dependencies(None, DEPENDENCIES)
    assert agent.ensured == ("curl", "bash", "procps")
    for user in ("root", 0, None):
        agent = adapter.SelfBenchClaudeCode("apk")
        await agent.install(types.SimpleNamespace(default_user=user))
        assert agent.installed and agent.root == []
    await agent.ensure_system_dependencies(None, DEPENDENCIES)
    assert agent.ensured == DEPENDENCIES
    # Debian's npm conflicts with an image's NodeSource Node, so Codex installs only what it runs.
    codex = adapter.SelfBenchCodex("apt-get")
    await codex.ensure_system_dependencies(None, ("curl", "bash", "nodejs", "npm", "ripgrep"))
    assert codex.ensured == ("curl", "bash", "ripgrep"), codex.ensured
    # The gateway takes the key as x-api-key: no bearer-token rewrite is left to apply.
    assert "_resolve_auth_env" not in adapter.SelfBenchClaudeCode.__dict__
asyncio.run(check())
`,
    ADAPTER,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("gateway Pi writes its models.json, then runs with only the gateway key", async () => {
  const trialInput = input("openrouter", "openrouter/vendor/model");
  const trial = gatewayTrial(trialInput, "pi", trialInput.modelName, {}, connect(trialInput, "pi"));
  const modelsJson = trial.agentArguments[1]?.slice("models_json=".length) ?? "";
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, json, os, subprocess, sys, tempfile, types
${HARBOR_STUBS}
class Pi:
    def __init__(self, models_json):
        self.options, self.commands = types.SimpleNamespace(models_json=models_json), []
    async def exec_as_agent(self, environment, command):
        self.commands.append(command)
    async def run(self, instruction, environment, context):
        self.commands.append("pi " + instruction)
sys.modules["harbor.agents.installed.pi"].Pi = Pi
sys.modules["harbor.agents.installed.codex"] = types.SimpleNamespace(Codex=object)
sys.modules["harbor.agents.installed.claude_code"] = types.SimpleNamespace(ClaudeCode=object)
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
assert adapter.GatewayPi.options_model is adapter.GatewayPiOptions
# Harbor resolves Pi's key from OPENAI_API_KEY alone; no gateway vendor's variable is left.
assert adapter.GatewayPi.MODEL_CONNECTION == {"passthrough": True, "api_key_envs": ("OPENAI_API_KEY",)}
models = json.loads(sys.argv[2])
agent = adapter.GatewayPi(models)
asyncio.run(agent.run("task", None, None))
write, start = agent.commands
assert start == "pi task"
with tempfile.TemporaryDirectory() as home:
    subprocess.check_call(["bash", "-c", write], env={**os.environ, "HOME": home})
    with open(os.path.join(home, ".pi/agent/models.json")) as file:
        assert json.load(file) == models
try:
    asyncio.run(adapter.GatewayPi(None).run("task", None, None))
    raise SystemExit("ran without models.json")
except ValueError:
    pass
`,
    ADAPTER,
    modelsJson,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

const gatewayKinds = [
  ["openai", "openai/gpt-6-sol"],
  ["anthropic", "anthropic/claude-opus-5-5"],
  ["openrouter", "openrouter/anthropic/claude-sonnet-5"],
  ["vercel-ai-gateway", "vercel-ai-gateway/anthropic/claude-sonnet-5"],
  ["custom", "openai/acme-coder"],
] as const;

for (const [provider, modelName] of gatewayKinds) {
  test(`a ${provider} API key reaches every harness through the gateway`, () => {
    const trialInput = input(provider, modelName, "high");
    const gatewayModel = provider === "custom" ? "custom/acme-coder" : modelName;
    const request = `dari/model/${gatewayModel}`;
    // The worker's host credentials never reach a trial, and neither does the provider's key.
    const env = {
      PATH: "/bin",
      OPENAI_API_KEY: "raw-openai",
      ANTHROPIC_API_KEY: "raw-anthropic",
      OPENROUTER_API_KEY: "raw-openrouter",
      AI_GATEWAY_API_KEY: "raw-vercel",
      META_API_KEY: "raw-meta",
    };
    const original = { ...env };
    // Muse Code runs only on Meta keys, which stay direct (see the Meta test below).
    const harnesses = harnessIds.filter((harness) => harness !== "muse-code");
    for (const harness of harnesses) {
      expect(trialRoute(trialInput, harness)).toBe("gateway");
      const connection = connect(trialInput, harness);
      const trial = gatewayTrial(trialInput, harness, modelName, env, connection);
      expect(connection.requestModel).toBe(request);
      expect(trial.extraAllowedHosts).toEqual(["api.selfbench.test"]);
      expect(Object.values(trial.child).filter((value) => value?.startsWith("raw-"))).toEqual([]);
      const keyed = Object.entries(trial.child).filter(([name]) => name !== "PATH");
      // The key pins the model, and the level for every harness but Claude Code.
      const key = readTrialKey(connection.key, SECRET);
      expect(key).toMatchObject({ orgId: 7, credentialId: CREDENTIAL, model: gatewayModel });
      expect(key?.thinking).toBe(harness === "claude-code" ? undefined : "high");
      expect(key?.tags).toEqual({ run: "r1", trial: "r1/0", harness });
      if (harness === "claude-code") {
        expect(trial).toMatchObject({
          model: request,
          agent: "harbor_gateway:SelfBenchClaudeCode",
          agentArguments: ["--agent-kwarg", "reasoning_effort=high"],
        });
        expect(Object.fromEntries(keyed)).toEqual({
          ANTHROPIC_API_KEY: connection.key,
          ANTHROPIC_BASE_URL: "https://api.selfbench.test/gateway",
        });
      } else if (harness === "pi") {
        expect(trial.model).toBe(`selfbench/${request}`);
        expect(trial.agent).toBe("harbor_gateway:GatewayPi");
        expect(Object.fromEntries(keyed)).toEqual({ OPENAI_API_KEY: connection.key });
        const models = JSON.parse(trial.agentArguments[1]?.slice("models_json=".length) ?? "");
        expect(models.providers.selfbench).toMatchObject({
          baseUrl: "https://api.selfbench.test/gateway/v1",
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          models: [{ id: request }],
        });
        // The key itself is read from the environment, never written to the file.
        expect(trial.agentArguments.join(" ")).not.toContain(connection.key);
      } else {
        expect(trial.model).toBe(`openai/${request}`);
        expect(trial.agent).toBe(harness === "codex" ? "harbor_gateway:GatewayCodex" : harness);
        // The gateway pins the level; Mini-SWE-Agent and Terminus 2 send none ("none" is refused).
        expect(trial.agentArguments).toEqual(
          harness === "codex" ? ["--agent-kwarg", "reasoning_effort=high"] : [],
        );
        expect(Object.fromEntries(keyed)).toEqual({
          OPENAI_API_KEY: connection.key,
          OPENAI_BASE_URL: "https://api.selfbench.test/gateway/v1",
          OPENAI_API_BASE: "https://api.selfbench.test/gateway/v1",
        });
      }
      const args = solverArguments("task", "jobs", trial, "modal", trial.extraAllowedHosts);
      expect(
        args.flatMap((arg, index) => (arg === "--allow-agent-host" ? [args[index + 1]] : [])),
      ).toEqual(["api.selfbench.test"]);
      expect(args[args.indexOf("--model") + 1]).toBe(trial.model);
    }
    expect(env).toEqual(original);
    // A gateway route never runs without its connection.
    expect(() => gatewayTrial(trialInput, "codex", modelName, env)).toThrow(
      "Model gateway connection is missing",
    );
  });
}
