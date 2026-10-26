import { createHash } from "node:crypto";
import type { GatewayPlatform, RequestSummary } from "@mupt-ai/dari-gateway";
import { HttpError } from "@mupt-ai/dari-gateway/http/errors";
import type { CredentialInfo, CredentialSecret } from "../db/credentials.js";
import { readTrialKey, type TrialKey } from "./trial-key.js";

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
    find(orgId: number, id: string): Promise<CredentialInfo | undefined>;
    secret(orgId: number, id: string): Promise<CredentialSecret | undefined>;
  };
  /**
   * The gateway's config for a model Pi's catalog may lack (its provider, native id, API and
   * prices), as the model listing describes it. Undefined leaves the model to Pi's catalog.
   */
  readonly modelConfig?: (model: string) => Record<string, unknown> | undefined;
  /** Must not throw: the gateway calls it after the response is sent. */
  readonly recordUsage: (usage: GatewayUsage) => void;
  readonly captureError: (error: unknown) => void;
}

const ROUTER_ID = "selfbench";

/**
 * SelfBench's gateway platform. A request authenticates with a trial key (trial-key.ts), which
 * pins one model on one of the org's credentials: the router is strict, so the gateway serves
 * exactly that model and never falls back, leases, or uses a subscription. Conversation routing
 * state is not kept, since a strict router never reads it.
 */
export function selfBenchPlatform(deps: SelfBenchGatewayDeps): GatewayPlatform {
  // The key behind each api_key_id this process resolved, so recordRequest can attribute usage.
  const resolved = new Map<string, TrialKey>();
  const keyOf = (token: string) => {
    const key = readTrialKey(token, deps.secret);
    if (!key)
      throw new HttpError(401, "Invalid or expired SelfBench gateway key.", "invalid_api_key");
    return key;
  };
  return {
    async resolveRouter({ apiKey }) {
      const key = keyOf(apiKey);
      if (!(await deps.credentials.find(key.orgId, key.credentialId)))
        throw new HttpError(401, "The trial's credential was removed.", "invalid_api_key");
      const id = createHash("sha256").update(apiKey).digest("base64url").slice(0, 22);
      const config = deps.modelConfig?.(key.model);
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
        strict: true,
        model_fallback_enabled: false,
        lease_context_enabled: false,
        // Benchmark transcripts are kept by Harbor; the gateway's log row needs no content.
        zdr: true,
      };
    },
    async resolveProviderCredential({ apiKey }) {
      const key = keyOf(apiKey);
      const [info, secret] = await Promise.all([
        deps.credentials.find(key.orgId, key.credentialId),
        deps.credentials.secret(key.orgId, key.credentialId),
      ]);
      if (!info || !secret?.value)
        throw new HttpError(401, "The trial's credential is unavailable.", "invalid_api_key");
      // A custom credential's own endpoint replaces the provider's.
      return { apiKey: secret.value, ...(info.endpoint ? { baseUrl: info.endpoint } : {}) };
    },
    async writePrefixState() {},
    async writePendingLease() {},
    async markSubscriptionUnavailable() {
      return false;
    },
    async recordUsage() {
      throw new Error("SelfBench's gateway serves only the org's own keys.");
    },
    recordRequest({ summary, tags }) {
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
    captureRequestError(error) {
      deps.captureError(error);
    },
    captureOperationalError(error) {
      deps.captureError(error);
    },
  };
}
