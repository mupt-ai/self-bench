import { expect, test } from "bun:test";
import { catalog } from "../src/evaluation/catalog.js";
import { credentialSchema } from "../src/evaluation/credentials.js";
import { gatewayTrial } from "../src/evaluation/gateway-execution.js";
import { routeFor } from "../src/evaluation/model-options.js";
import { solverArguments } from "../src/evaluation/runner.js";
import type { EvaluationInput } from "../src/evaluation/types.js";

for (const provider of ["openrouter"] as const) {
  test(`${provider} uses each harness protocol and preserves gateway model IDs`, () => {
    const input = { credentials: { provider } } as EvaluationInput;
    const env = {
      OPENROUTER_API_KEY: "test-key",
    };
    const original = { ...env };
    const name = `${provider}/anthropic/claude-sonnet-5`;
    const claude = gatewayTrial(input, "claude-code", name, env);
    expect(claude.model).toBe("anthropic/claude-sonnet-5");
    expect(claude.child.ANTHROPIC_API_KEY).toBe("test-key");
    expect(claude.child.OPENAI_API_KEY).toBeUndefined();
    const codex = gatewayTrial(input, "codex", name, env);
    expect(codex.model).toBe("openai/anthropic/claude-sonnet-5");
    expect(codex.child.OPENAI_API_KEY).toBe("test-key");
    expect(codex.child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codex.child.OPENAI_BASE_URL).toContain("openrouter.ai/api/v1");
    expect(solverArguments("task", "jobs", "codex", codex.model, "e2b")).toContain(
      "harbor_gateway:GatewayCodex",
    );
    for (const harness of ["mini-swe-agent", "terminus-2"] as const) {
      const result = gatewayTrial(input, harness, name, env);
      expect(result.model).toBe(codex.model);
      expect(result.child.OPENAI_API_BASE).toBe(codex.child.OPENAI_BASE_URL);
    }
    expect(env).toEqual(original);
    expect(() => gatewayTrial(input, "codex", name, {})).toThrow("Gateway credential");
  });
}

test("gateway connections offer cross-provider harnesses while direct OpenAI stays compatible", () => {
  const model = catalog.find((entry) => entry.id === "openai-sol56");
  if (!model) throw new Error("Missing model fixture");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("claude-code");
  expect(routeFor(model, "openrouter")?.harnesses).toContain("mini-swe-agent");
  expect(routeFor(model, "openai")?.harnesses).not.toContain("claude-code");
  expect(routeFor(model, "vercel")).toBeUndefined();
  expect(
    credentialSchema.parse({ name: "Gateway", kind: "openrouter", value: "test-key" }).kind,
  ).toBe("openrouter");
  expect(() =>
    credentialSchema.parse({
      name: "Gateway",
      kind: "openrouter",
      value: "test-key",
      endpoint: "https://wrong.example",
    }),
  ).toThrow();
});
