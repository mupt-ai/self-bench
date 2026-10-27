import { expect, test } from "bun:test";
import { gatewayTrial } from "../src/evaluation/gateway-trial.js";
import { solverArguments } from "../src/evaluation/solver-arguments.js";
import type { EvaluationInput } from "../src/evaluation/types.js";

test("solver invocation carries the trial's agent, model and arguments", () => {
  const args = solverArguments(
    "/task",
    "/jobs",
    {
      agent: "harbor_gateway:GatewayCodex",
      model: "openai/gpt-6-astra",
      agentArguments: ["--agent-kwarg", "reasoning_effort=max"],
    },
    "e2b",
  );
  expect(args.slice(-2)).toEqual(["--agent-kwarg", "reasoning_effort=max"]);
  expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-6-astra");
  expect(args[args.indexOf("--agent") + 1]).toBe("harbor_gateway:GatewayCodex");
});

test("Dari's router on a custom endpoint keeps Harbor's explicit Chat Completions API style", () => {
  const input = {
    modelName: "openai/dari/routing",
    thinking: "high",
    credentials: { provider: "custom", auth: "api-key" },
  } as EvaluationInput;
  const env = { OPENAI_API_KEY: "key", OPENAI_BASE_URL: "https://routing.dari.dev/v1" };
  const pi = gatewayTrial(input, "pi", input.modelName, env);
  expect(pi.agentArguments).toEqual([
    "--agent-kwarg",
    "thinking=high",
    "--agent-kwarg",
    "model_api=openai-completions",
  ]);
  expect(pi.extraAllowedHosts).toEqual(["routing.dari.dev"]);
});

test("solver argv cannot trigger author/oracle gates or implicit retries", () => {
  const args = solverArguments(
    "/task space",
    "/jobs",
    { agent: "codex", model: "openai/test-model", agentArguments: [] },
    "docker",
  );
  expect(args).toContain("/task space");
  expect(args.slice(args.indexOf("--max-retries"), args.indexOf("--max-retries") + 2)).toEqual([
    "--max-retries",
    "0",
  ]);
  expect(args).not.toContain("oracle");
  expect(args).not.toContain("nop");
});
