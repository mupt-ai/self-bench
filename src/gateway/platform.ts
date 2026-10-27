import { createHash } from "node:crypto";
import type {
  GatewayPlatform,
  ProviderCredential,
  RequestSummary,
  ResolvedRouter,
} from "@mupt-ai/dari-gateway";
import { HttpError } from "@mupt-ai/dari-gateway/http/errors";
import type { CredentialInfo, CredentialSecret } from "../db/credentials.js";
import { MANAGED_MODEL_CREDENTIAL, readTrialKey, type TrialKey } from "./trial-key.js";

/** The gateway's description of one model: its provider, native id, API, limits and prices. */
export type GatewayModelConfig = NonNullable<ResolvedRouter["model_configs"]>[string];
/** A model's list price, in $ per million tokens. */
export type GatewayModelPrice = GatewayModelConfig["cost"];

/** One model call the gateway served for a trial, with what it cost. */
export interface GatewayUsage {
  readonly requestId: string;
  readonly orgId: number;
  readonly credentialId: string;
  readonly model: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly status: RequestSummary["status"];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costUsd: number | null;
  readonly costSource: RequestSummary["cost_source"];
}

export interface SelfBenchGatewayDeps {
  readonly secret: string;
  readonly credentials: {
    find(
      orgId: number,
      id: string,
    ): Promise<Pick<CredentialInfo, "id" | "kind" | "auth" | "endpoint"> | undefined>;
    secret(orgId: number, id: string): Promise<Pick<CredentialSecret, "value"> | undefined>;
  };
  /**
   * The gateway's config for a model Pi's catalog may lack (its provider, native id, API and
   * prices), as the model listing describes it. Undefined leaves the model to Pi's catalog.
   */
  readonly modelConfig?: (model: string) => GatewayModelConfig | undefined;
  /**
   * The model's list price, which prices each call the provider does not price itself (gateways
   * such as OpenRouter report what they billed). Undefined leaves those calls unpriced.
   */
  readonly modelPrice?: (model: string) => GatewayModelPrice | undefined;
  /**
   * A custom credential's endpoint, once it is checked to be one the operator allows the API to
   * call (validateEndpoint); throws when it is not.
   */
  readonly endpoint: (endpoint: string) => string;
  /** Must not throw: the gateway calls it after the response is sent. */
  readonly recordUsage: (usage: GatewayUsage) => void;
  readonly captureError: (error: unknown) => void;
}

const ROUTER_ID = "selfbench";

/**
 * The platform's two lookups, narrowed to what a trial key carries: the gateway's own requests
 * also name a router and an organization, which SelfBench's single router does not need.
 */
export type SelfBenchPlatform = Omit<
  GatewayPlatform,
  "resolveRouter" | "resolveProviderCredential"
> & {
  resolveRouter(request: { apiKey: string }): Promise<ResolvedRouter>;
  resolveProviderCredential(request: {
    apiKey: string;
    model?: string;
  }): Promise<ProviderCredential | undefined>;
};

/**
 * SelfBench's gateway platform. A request authenticates with a trial key (trial-key.ts), which
 * pins one model on one of the org's credentials: the router is strict, so the gateway serves
 * exactly that model (at the key's thinking level, when it names one) and never falls back,
 * leases, or uses a subscription. Conversation routing state is not kept, since a strict router
 * never reads it.
 */
export function selfBenchPlatform(deps: SelfBenchGatewayDeps): SelfBenchPlatform {
  // The key behind each api_key_id this process resolved, so recordRequest can attribute usage.
  const resolved = new Map<string, TrialKey>();
  const keyOf = (token: string) => {
    const key = readTrialKey(token, deps.secret);
    if (!key)
      throw new HttpError(401, "Invalid or expired SelfBench gateway key.", "invalid_api_key");
    return key;
  };
  return {
    async resolveRouter({ apiKey }: { apiKey: string }) {
      const key = keyOf(apiKey);
      const credential = await deps.credentials.find(key.orgId, key.credentialId);
      if (!credential)
        throw new HttpError(401, "The trial's credential was removed.", "invalid_api_key");
      const id = createHash("sha256").update(apiKey).digest("base64url").slice(0, 22);
      const config = modelConfig(deps, key, {
        kind: credential.kind,
        ...(credential.endpoint ? { endpoint: allowedEndpoint(deps, credential.endpoint) } : {}),
      });
      const price = deps.modelPrice?.(key.model);
      for (const [stale, entry] of resolved)
        if (entry.expiresAt <= Date.now()) resolved.delete(stale);
      resolved.set(id, key);
      return {
        router_id: ROUTER_ID,
        organization_id: String(key.orgId),
        api_key_id: id,
        attributed_user_id: null,
        enabled_models: [key.model],
        provider_keys: {},
        ...(config ? { model_configs: { [key.model]: config } } : {}),
        ...(price ? { model_prices: { [key.model]: price } } : {}),
        // A pinned level is the only one served, whatever level a call asks for or omits.
        ...(key.thinking ? { model_thinking_levels: { [key.model]: [key.thinking] } } : {}),
        strict: true,
        model_fallback_enabled: false,
        lease_context_enabled: false,
        // Zero data retention would also restrict OpenRouter and Vercel to their ZDR endpoints,
        // which a direct key never was. The gateway keeps no content here either way: Harbor keeps
        // the transcripts, and recordRequest reads only the summary.
        zdr: false,
      };
    },
    async resolveProviderCredential({
      apiKey,
    }: {
      apiKey: string;
      model?: string;
    }): Promise<ProviderCredential> {
      const key = keyOf(apiKey);
      const [info, secret] = await Promise.all([
        deps.credentials.find(key.orgId, key.credentialId),
        deps.credentials.secret(key.orgId, key.credentialId),
      ]);
      if (!info || !secret?.value)
        throw new HttpError(401, "The trial's credential is unavailable.", "invalid_api_key");
      // A custom credential's own endpoint replaces the provider's.
      return {
        apiKey: secret.value,
        ...(info.endpoint ? { baseUrl: allowedEndpoint(deps, info.endpoint) } : {}),
      };
    },
    async writePrefixState() {},
    async writePendingLease() {},
    async markSubscriptionUnavailable() {
      return false;
    },
    async recordUsage() {
      throw new Error("SelfBench's gateway serves only the org's own keys.");
    },
    recordRequest({ summary, tags }: { summary: RequestSummary; tags: Record<string, string> }) {
      const key = summary.api_key_id ? resolved.get(summary.api_key_id) : undefined;
      if (!key) return;
      try {
        deps.recordUsage({
          requestId: summary.request_id,
          orgId: key.orgId,
          credentialId: key.credentialId,
          model: key.model,
          // The key's tags win: a header can add labels but never reattribute spend.
          tags: { ...tags, ...key.tags },
          status: summary.status,
          inputTokens: summary.input_tokens,
          outputTokens: summary.output_tokens,
          cacheReadTokens: summary.cache_read_tokens,
          cacheWriteTokens: summary.cache_write_tokens,
          costUsd: summary.total_cost_usd,
          costSource: summary.cost_source,
        });
      } catch (error) {
        deps.captureError(error);
      }
    },
    captureRequestError(error: unknown) {
      deps.captureError(error);
    },
    captureOperationalError(error: unknown) {
      deps.captureError(error);
    },
  };
}

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
 * The model as the listing describes it, or as a custom credential serves it: an OpenAI Chat
 * Completions endpoint at its own address, whose models no catalog prices. A pinned thinking
 * level is also its default, which the strict router checks every call against.
 */
function modelConfig(
  deps: SelfBenchGatewayDeps,
  key: TrialKey,
  credential: Pick<CredentialInfo, "kind" | "endpoint">,
): GatewayModelConfig | undefined {
  const config =
    deps.modelConfig?.(key.model) ??
    (credential.kind === "custom" && credential.endpoint
      ? {
          provider: "custom",
          native_model_id: key.model.slice(key.model.indexOf("/") + 1),
          api: "openai-completions",
          base_url: credential.endpoint,
          cost: { input: 0, output: 0 },
        }
      : undefined);
  return config && key.thinking ? { ...config, default_thinking_level: key.thinking } : config;
}

/**
 * The org's credentials, plus SelfBench's own OpenRouter account as the managed model credential
 * when `managedKey` (the platform's OpenRouter key) is set.
 */
export function withManagedModel(
  credentials: SelfBenchGatewayDeps["credentials"],
  managedKey: string | undefined,
): SelfBenchGatewayDeps["credentials"] {
  const managed = (id: string) => id === MANAGED_MODEL_CREDENTIAL;
  return {
    find: async (orgId, id) =>
      managed(id)
        ? managedKey
          ? { id, kind: "openrouter", auth: "api-key" }
          : undefined
        : credentials.find(orgId, id),
    secret: async (orgId, id) =>
      managed(id)
        ? managedKey
          ? { value: managedKey }
          : undefined
        : credentials.secret(orgId, id),
  };
}
