import { HttpError } from "@mupt-ai/dari-gateway/http/errors";
import { dariEndpoint } from "../db/credential-endpoints.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { GatewayModelConfig, SelfBenchGatewayDeps } from "./platform.js";
import type { TrialKey } from "./trial-key.js";

function allowedEndpoint(deps: SelfBenchGatewayDeps, endpoint: string): string {
  try {
    return deps.endpoint(endpoint);
  } catch {
    throw new HttpError(
      403,
      "The credential's endpoint is not one this deployment allows.",
      "endpoint_not_allowed",
    );
  }
}

/**
 * The model as the catalog describes it, as Dari's router serves it, or as a custom credential
 * serves it: an endpoint at its own address, called in the trial's harness's protocol (TrialKey's
 * `api`, else Chat Completions), whose models no catalog prices. A pinned thinking level is also
 * its default, which the strict router checks every call against.
 */
export function modelConfig(
  deps: SelfBenchGatewayDeps,
  key: TrialKey,
  credential: Pick<CredentialInfo, "kind" | "endpoint">,
): GatewayModelConfig | undefined {
  const { model, thinking } = key;
  if (!model) return undefined;
  const config =
    deps.modelConfig?.(model) ??
    (credential.kind === "dari"
      ? dariModelConfig(credential.endpoint)
      : credential.kind === "custom" && credential.endpoint
        ? {
            provider: "custom",
            native_model_id: model.slice(model.indexOf("/") + 1),
            api: key.api ?? "openai-completions",
            base_url: customBaseUrl(deps, credential.endpoint, key),
            // With no level asked for (endpointEffort), the call goes without one.
            ...(key.endpointEffort ? { supported_thinking_levels: ["off" as const] } : {}),
            ...ROUTER_LIMITS,
            cost: { input: 0, output: 0 },
          }
        : undefined);
  return config && thinking ? { ...config, default_thinking_level: thinking } : config;
}

/**
 * A custom credential's endpoint as the trial's API client takes it. The endpoint is saved as an
 * OpenAI base URL (`…/v1`); Anthropic's client appends `/v1/messages` itself, so it takes the
 * address without that `/v1`.
 */
export function customBaseUrl(deps: SelfBenchGatewayDeps, endpoint: string, key: TrialKey): string {
  const base = allowedEndpoint(deps, endpoint);
  return key.api === "anthropic-messages" ? base.replace(/\/v1$/, "") : base;
}

/**
 * Dari's router, for a harness other than Pi (Codex, Claude Code), at the router its credential
 * names. Whatever protocol the harness speaks, the gateway calls Dari's Chat Completions, the one
 * API on which Dari returns each call's price: OpenRouter's `usage.cost` on the final chunk.
 * Naming the provider `openrouter` makes the gateway read that price (provider_reported_cost),
 * and the base URL keeps the call on Dari. Dari bills the call, so its price is the trial's cost.
 */
function dariModelConfig(endpoint: string | null | undefined): GatewayModelConfig {
  return {
    provider: "openrouter",
    native_model_id: "dari/routing",
    api: "openai-completions",
    base_url: dariEndpoint(endpoint ?? undefined),
    // The router picks each call's effort, and refuses OpenRouter's `reasoning` field.
    supported_thinking_levels: ["off"],
    ...ROUTER_LIMITS,
    cost: { input: 0, output: 0 },
  };
}

/**
 * The limits a router endpoint is described with, whose model the catalog does not know (Dari,
 * Shift-1, Ramp's Switchyard). Without them the gateway takes a 128k context window, and Pi caps
 * each call's output at what that window leaves after the prompt: a long Codex run's ~124k prompt
 * left almost none, so the router stopped every turn at `max_output_tokens`. The router serves
 * models with windows of 400k to 1M tokens and enforces each one's own limits, so the gateway
 * takes the largest and leaves the rest to it.
 */
const ROUTER_LIMITS = { context_window: 1_048_576, max_output_tokens: 128_000 } as const;
