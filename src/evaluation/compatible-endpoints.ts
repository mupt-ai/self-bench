import type { Harness } from "./models.js";

export interface CompatibleEndpoint {
  /** The provider's own CLI, which speaks its API natively. */
  native: Harness;
  openAiBase: string;
  /** Takes the key as a bearer token (ANTHROPIC_AUTH_TOKEN), not as x-api-key. */
  anthropicBase: string;
}

/**
 * Direct providers whose API also speaks the protocols the other harnesses use. Meta's Model API
 * serves OpenAI's Responses and Chat Completions and Anthropic's Messages
 * (dev.meta.ai/docs/coding-agents), so a Meta key drives every harness, Muse Code natively.
 */
const compatibleEndpoints: Partial<Record<string, CompatibleEndpoint>> = {
  meta: {
    native: "muse-code",
    openAiBase: "https://api.meta.ai/v1",
    anthropicBase: "https://api.meta.ai",
  },
};

/** The endpoint a harness reaches a direct provider through, unless it is the provider's CLI. */
export function compatibleEndpoint(
  provider: string | undefined,
  harness: Harness,
): CompatibleEndpoint | undefined {
  const endpoint = provider ? compatibleEndpoints[provider] : undefined;
  return endpoint?.native === harness ? undefined : endpoint;
}
