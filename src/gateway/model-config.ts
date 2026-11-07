import { HttpError } from "@mupt-ai/dari-gateway/http/errors";
import { pi } from "@mupt-ai/dari-gateway/providers/pi";
import type { ThinkingLevel } from "../contracts/models.js";
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
 * serves it: an endpoint at its own address. A model Pi's registry knows by the endpoint's own id
 * (registryModel) is served as Pi serves it; any other is called in the trial's harness's protocol
 * (TrialKey's `api`, else Chat Completions), and no catalog prices it. A pinned thinking level is
 * also its default, which the strict router checks every call against.
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
        ? customModelConfig(deps, key, model, credential.endpoint)
        : undefined);
  return config && thinking ? { ...config, default_thinking_level: thinking } : config;
}

function customModelConfig(
  deps: SelfBenchGatewayDeps,
  key: TrialKey,
  model: string,
  endpoint: string,
): GatewayModelConfig {
  const native = model.slice(model.indexOf("/") + 1);
  const registered = registryModel(model);
  if (registered)
    return {
      provider: registered.provider,
      native_model_id: native,
      api: registered.api,
      base_url: customBaseUrl(deps, endpoint, key),
      // Null leaves the levels, their wire values and the limits to Pi's registry entry.
      supported_thinking_levels: null,
      context_window: registered.contextWindow,
      max_output_tokens: registered.maxTokens,
      // A call that names no level (Pi, and Codex's dropped one) is served at the model's own
      // default, thinking, rather than the first level the registry lists, which is off.
      ...(registered.defaultLevel ? { default_thinking_level: registered.defaultLevel } : {}),
      cost: registered.cost,
    };
  return {
    provider: "custom",
    native_model_id: native,
    api: key.api ?? "openai-completions",
    base_url: customBaseUrl(deps, endpoint, key),
    // With no level asked for (endpointEffort), the call goes without one.
    ...(key.endpointEffort ? { supported_thinking_levels: ["off" as const] } : {}),
    ...ROUTER_LIMITS,
    cost: { input: 0, output: 0 },
  };
}

/**
 * A custom credential's endpoint as the trial's API client takes it. The endpoint is saved as an
 * OpenAI base URL (`…/v1`); Anthropic's client appends `/v1/messages` itself, so it takes the
 * address without that `/v1`. A model Pi's registry knows is called at its registry address's
 * path on the credential's host: Fireworks' Messages API is `/inference`, its Chat Completions
 * `/inference/v1`, whichever of the two the credential was saved with.
 */
export function customBaseUrl(deps: SelfBenchGatewayDeps, endpoint: string, key: TrialKey): string {
  const base = allowedEndpoint(deps, endpoint);
  const registered = key.model ? registryModel(key.model) : undefined;
  if (registered) return new URL(registered.path, base).toString().replace(/\/$/, "");
  return key.api === "anthropic-messages" ? base.replace(/\/v1$/, "") : base;
}

/**
 * The providers whose models Pi's registry lists under ids only that provider serves
 * (`accounts/fireworks/routers/kimi-fast-latest`), so a custom endpoint serving one is that
 * provider, or a proxy for it. Fire Pass keys reach only Fireworks' routers, which take no
 * Responses calls, so Codex's calls are served as Pi serves the router (its Messages API).
 */
const REGISTRY_PROVIDERS = ["fireworks"] as const;

/** The levels a model's own default is taken from when a call names none, first listed first. */
const DEFAULT_LEVELS = ["high", "medium"] as const satisfies readonly ThinkingLevel[];

interface RegistryModel {
  readonly provider: (typeof REGISTRY_PROVIDERS)[number];
  readonly api: string;
  /** Its address's path, which the credential's host serves it under. */
  readonly path: string;
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
  readonly defaultLevel: (typeof DEFAULT_LEVELS)[number] | undefined;
  readonly cost: GatewayModelConfig["cost"];
}

/**
 * The registry's entry for a custom endpoint's model `custom/<id>`, when a provider in
 * REGISTRY_PROVIDERS lists `<id>`: its API, address, limits, thinking and list price.
 */
export function registryModel(model: string): RegistryModel | undefined {
  if (!model.startsWith("custom/")) return undefined;
  const id = model.slice("custom/".length);
  for (const provider of REGISTRY_PROVIDERS) {
    const entry = pi.getModel?.(provider, id);
    if (!entry || typeof entry.api !== "string" || typeof entry.baseUrl !== "string") continue;
    const levels = record(entry.thinkingLevelMap);
    const cost = record(entry.cost);
    return {
      provider,
      api: entry.api,
      path: new URL(entry.baseUrl).pathname,
      contextWindow: number(entry.contextWindow) ?? null,
      maxTokens: number(entry.maxTokens) ?? null,
      defaultLevel:
        entry.reasoning === true
          ? DEFAULT_LEVELS.find((level) => typeof levels[level] === "string")
          : undefined,
      cost: {
        input: number(cost.input) ?? 0,
        output: number(cost.output) ?? 0,
        cached_input: number(cost.cacheRead) ?? null,
        cache_write: number(cost.cacheWrite) ?? null,
      },
    };
  }
  return undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
