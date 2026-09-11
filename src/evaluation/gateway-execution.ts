import type { EvaluationInput, Harness } from "./types.js";

export const gateways = {
  openrouter: { base: "https://openrouter.ai/api/v1", messages: "https://openrouter.ai/api" },
} as const;

/** Adapt the selected connection to each harness without inheriting host credentials. */
export function gatewayTrial(
  input: EvaluationInput,
  harness: Harness,
  model: string,
  env: NodeJS.ProcessEnv,
) {
  const provider = input.credentials?.provider;
  if (provider !== "openrouter") return { model, child: { ...env } };
  const gateway = gateways[provider];
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new Error("Gateway credential is unavailable");
  const modelId = model.slice(provider.length + 1);
  const child = { ...env };
  delete child.OPENROUTER_API_KEY;
  delete child.AI_GATEWAY_API_KEY;
  if (harness === "claude-code") {
    child.ANTHROPIC_API_KEY = key;
    child.ANTHROPIC_BASE_URL = gateway.messages;
    return { model: modelId, child };
  }
  if (harness === "pi") {
    child.OPENROUTER_API_KEY = key;
    return { model, child };
  }
  child.OPENAI_API_KEY = key;
  child.OPENAI_BASE_URL = gateway.base;
  child.OPENAI_API_BASE = gateway.base;
  return { model: `openai/${modelId}`, child };
}
