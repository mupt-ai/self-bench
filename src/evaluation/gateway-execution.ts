import type { EvaluationInput, Harness } from "./types.js";

const gateways = {
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    messages: "https://openrouter.ai/api",
    hosts: ["openrouter.ai", "*.openrouter.ai"],
  },
} as const;

function hostsFromEnvironment(env: NodeJS.ProcessEnv): string[] {
  return ["OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL"]
    .flatMap((key) => {
      const value = env[key];
      if (!value) return [];
      try {
        return [new URL(value).hostname];
      } catch {
        return [];
      }
    })
    .filter((host, index, hosts) => hosts.indexOf(host) === index);
}

function providerHosts(provider: string | undefined, env: NodeJS.ProcessEnv): string[] {
  if (provider === "openrouter") return [...gateways.openrouter.hosts];
  if (provider === "anthropic") return ["api.anthropic.com"];
  if (provider === "openai") return ["api.openai.com"];
  return hostsFromEnvironment(env);
}

export function solverAgent(harness: Harness, model: string): string {
  if (harness !== "codex") return harness;
  return model.startsWith("openai/") && model.slice(7).includes("/")
    ? "harbor_gateway:GatewayCodex"
    : "harbor_gateway:SelfBenchCodex";
}

/** Adapt the selected connection to each harness without inheriting host credentials. */
export function gatewayTrial(
  input: EvaluationInput,
  harness: Harness,
  model: string,
  env: NodeJS.ProcessEnv,
) {
  const provider = input.credentials?.provider;
  if (provider !== "openrouter") {
    const child = { ...env };
    return { model, child, extraAllowedHosts: providerHosts(provider, child) };
  }
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
    return { model: modelId, child, extraAllowedHosts: [...gateway.hosts] };
  }
  if (harness === "pi") {
    child.OPENROUTER_API_KEY = key;
    return { model, child, extraAllowedHosts: [...gateway.hosts] };
  }
  child.OPENAI_API_KEY = key;
  child.OPENAI_BASE_URL = gateway.base;
  child.OPENAI_API_BASE = gateway.base;
  return { model: `openai/${modelId}`, child, extraAllowedHosts: [...gateway.hosts] };
}
