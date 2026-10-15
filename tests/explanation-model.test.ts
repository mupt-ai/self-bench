import { expect, test } from "bun:test";
import type { CredentialInfo } from "../src/db/credentials.js";
import {
  explanationModel,
  explanationSelectionSchema,
} from "../src/evaluation/explanation-model.js";
import { gateways, setGatewayListing } from "../src/gateways/index.js";

const key = (
  kind: CredentialInfo["kind"],
  extra: Partial<CredentialInfo> = {},
): CredentialInfo => ({
  id: crypto.randomUUID(),
  name: "My Key",
  kind,
  auth: "api-key",
  createdAt: "",
  ...extra,
});

test("explanations route chosen catalog models independently of the original solver", () => {
  for (const kind of ["openai", "openrouter", "vercel-ai-gateway"] as const) {
    const model = explanationModel(key(kind), "gpt-6-sol", {});
    expect(model.provider).toBe(kind);
    expect(model.model).toBe(kind === "openai" ? "gpt-6-sol" : "openai/gpt-6-sol");
    expect(model.summaryModel).toBe("gpt-6-sol");
  }
  expect(explanationModel(key("anthropic"), "claude-opus-5-5", {}).provider).toBe("anthropic");
  expect(() => explanationModel(key("anthropic"), "gpt-6-sol", {})).toThrow("selected API key");
  expect(() => explanationModel(key("e2b"), "gpt-6-sol", {})).toThrow("selected API key");
  expect(() => explanationModel(key("openai", { auth: "codex-login" }), "gpt-6-sol", {})).toThrow(
    "sign-in",
  );
});

test("custom explanation endpoints are saved, approved and use an environment key reference", () => {
  const credential = key("custom", { endpoint: "https://model.example/v1" });
  expect(() => explanationModel(credential, "my-model", {})).toThrow("operator-approved");
  const model = explanationModel(credential, "my-model", {
    SELFBENCH_CUSTOM_MODEL_HOSTS: "model.example",
  });
  expect(JSON.parse(model.models).providers.custom).toMatchObject({
    api: "openai-completions",
    baseUrl: "https://model.example/v1",
    apiKey: "$OPENAI_API_KEY",
  });
  expect(model.thinking).toBe("default");
  expect(
    explanationSelectionSchema.safeParse({ credentialId: credential.id, model: "!shell-command" })
      .success,
  ).toBe(false);
  expect(
    explanationSelectionSchema.safeParse({
      credentialId: credential.id,
      model: "my-model",
      endpoint: "http://localhost",
    }).success,
  ).toBe(false);
});

test("Vercel explanations preserve registry model compatibility", () => {
  const gateway = "vercel-ai-gateway";
  try {
    setGatewayListing(
      gateway,
      gateways[gateway].parse(
        {
          data: [
            {
              id: "openai/gpt-6-sol",
              name: "GPT-6 Sol",
              type: "language",
              tags: ["tool-use", "reasoning"],
              modalities: { input: ["text"], output: ["text"] },
              context_window: 200000,
              max_tokens: 32000,
              pricing: { input: "0.000002", output: "0.00001" },
              reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            },
          ],
        },
        "2026-10-14",
      ),
    );
    const model = explanationModel(key(gateway), "gpt-6-sol", {});
    const definition = JSON.parse(model.models).providers[gateway].models[0];
    expect(definition.contextWindow).toBe(200000);
    expect(definition.compat).toMatchObject({
      allowEmptySignature: true,
      forceAdaptiveThinking: true,
    });
    expect(definition.thinkingLevelMap).toEqual({ low: "low", high: "high" });
  } finally {
    setGatewayListing(gateway, { models: [], rates: new Map() });
  }
});
