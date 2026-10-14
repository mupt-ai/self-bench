import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { catalog } from "../src/evaluation/catalog.js";
import { trialCost } from "../src/evaluation/cost.js";
import {
  gatewayModel,
  gatewayTrial,
  solverAgent,
  solverAgentArguments,
} from "../src/evaluation/execution.js";
import {
  credentialRunsHarness,
  harnessIds,
  modelHarnesses,
  openHarnesses,
  routeFor,
  signInRefusal,
} from "../src/evaluation/models.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { runCommand } from "../src/lib/process.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

test("API keys run any harness; Claude and Meta sign-ins only their CLI; ChatGPT only Codex", () => {
  for (const harness of harnessIds) {
    expect(credentialRunsHarness("api-key", harness)).toBe(true);
    expect(credentialRunsHarness("claude-login", harness)).toBe(harness === "claude-code");
    expect(credentialRunsHarness("muse-login", harness)).toBe(harness === "muse-code");
    expect(credentialRunsHarness("codex-login", harness)).toBe(harness === "codex");
  }
  expect(signInRefusal("claude-login", ["claude-code", "pi"])).toBe(
    "A Claude Code sign-in can only run the Claude Code harness",
  );
  expect(signInRefusal("muse-login", ["codex"])).toBe(
    "A Muse Code sign-in can only run the Muse Code harness",
  );
  expect(signInRefusal("api-key", [...harnessIds])).toBeUndefined();
});

test("a model offers, before a credential is chosen, every harness some route runs", () => {
  const sol = catalog.find((model) => model.id === "gpt-6-sol");
  const spark = catalog.find((model) => model.id === "muse-spark-1.3");
  if (!sol || !spark) throw new Error("Missing model fixture");
  // Gateways carry an OpenAI model to Claude Code; only Meta's API runs Muse Code.
  expect(modelHarnesses(sol)).toEqual([...openHarnesses]);
  expect(modelHarnesses(spark)).toEqual([...harnessIds]);
  // Muse Code stays a Meta key's default.
  expect(routeFor(spark, "meta")?.harnesses[0]).toBe("muse-code");
});

test("a Meta key reaches every other harness through Meta's OpenAI and Anthropic APIs", () => {
  const input = { credentials: { provider: "meta" } } as EvaluationInput;
  const name = "meta/muse-spark-1.3";
  const env = { META_API_KEY: "test-key", PATH: "/bin" };
  const claude = gatewayTrial(input, "claude-code", name, env);
  expect(claude.model).toBe("muse-spark-1.3");
  // Meta's Messages API takes the key as a bearer token, never as x-api-key.
  expect(claude.child).toEqual({
    PATH: "/bin",
    ANTHROPIC_AUTH_TOKEN: "test-key",
    ANTHROPIC_BASE_URL: "https://api.meta.ai",
  });
  expect(claude.extraAllowedHosts).toEqual(["api.meta.ai"]);
  for (const harness of ["codex", "pi", "mini-swe-agent", "terminus-2"] as const) {
    const trial = gatewayTrial(input, harness, name, env);
    expect(trial.model).toBe("openai/muse-spark-1.3");
    expect(trial.child).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://api.meta.ai/v1",
      OPENAI_API_BASE: "https://api.meta.ai/v1",
    });
    expect(trial.extraAllowedHosts).toEqual(["api.meta.ai"]);
  }
  // Codex takes Meta's Responses API over HTTPS, as gateways do; Pi as a custom endpoint.
  expect(solverAgent("codex", "meta")).toBe("harbor_gateway:GatewayCodex");
  expect(solverAgent("pi", "meta")).toBe("pi");
  expect(solverAgentArguments("pi", "meta", "openai/muse-spark-1.3")).toEqual([
    "--agent-kwarg",
    "model_api=openai-responses",
  ]);
  expect(solverAgentArguments("codex", "meta", "openai/muse-spark-1.3")).toEqual([]);
  // Muse Code keeps Meta's own key and model name.
  const muse = gatewayTrial(input, "muse-code", name, env);
  expect(muse).toEqual({ model: name, child: env, extraAllowedHosts: ["api.meta.ai"] });
  expect(solverAgent("muse-code", "meta")).toBe("harbor_muse:SelfBenchMuseCode");
  expect(solverAgentArguments("muse-code", "meta", name)).toEqual([]);
  // Cost verification derives the same Harbor model name the runner passes.
  for (const harness of harnessIds)
    expect(gatewayModel("meta", harness, name)).toBe(gatewayTrial(input, harness, name, env).model);
  expect(() => gatewayTrial(input, "codex", name, { PATH: "/bin" })).toThrow(
    "Model credential is unavailable",
  );
});

test("a Meta trial on another vendor's harness is priced at reference rates", () => {
  const pricing = {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 2.5,
    source: "https://provider.example/pricing",
    asOf: "2026-10-13",
  };
  const trajectory = {
    agent: { model_name: "muse-spark-1.3" },
    steps: [{ source: "agent", metrics: { prompt_tokens: 1000, completion_tokens: 100 } }],
  };
  const files = new Map([["agent/trajectory.json", JSON.stringify(trajectory)]]);
  const result = {
    agent_result: { n_input_tokens: 1000, n_cache_tokens: 0, n_output_tokens: 100 },
  };
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      modelName: "meta/muse-spark-1.3",
      pricing,
      credentials: {
        modelCredentialId: "key",
        sandboxCredentialId: "sandbox",
        provider: "meta",
        auth: "api-key",
      },
    },
    "Test",
  );
  // Harbor's figure for a Muse model under Codex comes from another vendor's table.
  const meta = { agent_result: { ...result.agent_result, cost_usd: 99 } };
  expect(trialCost(run, "codex", files, meta)).toMatchObject({
    modelVerified: true,
    apiCostUsd: 0.0028,
    costSource: "reference-rates",
  });
});

test("Claude Code keeps a key given only as ANTHROPIC_AUTH_TOKEN a bearer token", async () => {
  const result = await runCommand("python3", [
    "-c",
    `import importlib.util, os, sys, types
class ClaudeCode:
    def _get_env(self, name):
        return os.environ.get(name)
    def _resolve_auth_env(self):
        # Harbor sends whichever key it resolved as ANTHROPIC_API_KEY.
        key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        return {"ANTHROPIC_API_KEY": key, "ANTHROPIC_BASE_URL": "https://api.meta.ai"}
sys.modules["harbor.agents.installed.claude_code"] = types.SimpleNamespace(ClaudeCode=ClaudeCode)
sys.modules["harbor.agents.installed.codex"] = types.SimpleNamespace(Codex=object)
sys.modules["harbor.agents.installed.pi"] = types.SimpleNamespace(Pi=object, PiOptions=object)
sys.modules["harbor.agents.model_connection"] = types.SimpleNamespace(ModelConnectionSpec=lambda **kwargs: kwargs)
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
agent = adapter.SelfBenchClaudeCode()
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ["ANTHROPIC_AUTH_TOKEN"] = "meta-key"
assert agent._resolve_auth_env() == {"ANTHROPIC_AUTH_TOKEN": "meta-key", "ANTHROPIC_BASE_URL": "https://api.meta.ai"}
os.environ["ANTHROPIC_API_KEY"] = "anthropic-key"
assert agent._resolve_auth_env()["ANTHROPIC_API_KEY"] == "anthropic-key"
`,
    fileURLToPath(new URL("../src/harnesses/harbor/runtime/harbor_gateway.py", import.meta.url)),
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});
