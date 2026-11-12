import { createHash } from "node:crypto";
import type {
  GatewayPlatform,
  ProviderCredential,
  RequestSummary,
  ResolvedRouter,
} from "@mupt-ai/dari-gateway";
import { HttpError } from "@mupt-ai/dari-gateway/http/errors";
import { dariEndpoint } from "../db/credential-endpoints.js";
import type { CredentialInfo, CredentialSecret } from "../db/credentials.js";
import type { TokenUsage } from "../evaluation/types.js";
import {
  customBaseUrl,
  endpointProvider,
  messagesEndpoint,
  modelConfig,
  registryModel,
} from "./model-config.js";
import { routerTables, subagentRouterModel } from "./router-models.js";
import { servedCost } from "./served-model.js";
import { signInCredential } from "./sign-in.js";
import { judgeCredential, readTrialKey, solverCredential, type TrialKey } from "./trial-key.js";

export { withManagedModel } from "./managed-model.js";

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
    /** Saves a sign-in's refreshed tokens. */
    renew(orgId: number, id: string, value: string): Promise<void>;
  };
  /**
   * The gateway's config for a model Pi's catalog may lack (its provider, native id, API and
   * prices), as the model catalog describes it. Undefined leaves the model to Pi's catalog.
   */
  readonly modelConfig?: (model: string) => GatewayModelConfig | undefined;
  /**
   * The model's list price, which prices each call the provider does not price itself (gateways
   * such as OpenRouter report what they billed). Undefined leaves those calls unpriced.
   */
  readonly modelPrice?: (model: string) => GatewayModelPrice | undefined;
  /**
   * What a custom endpoint's call cost at the list rates of the model its response says served it
   * (served-model.ts): the endpoint reports no price, and may be a router serving each call from a
   * different model. Undefined when no catalog prices that model, which leaves the call unpriced.
   */
  readonly servedModelCost?: (
    model: string,
    usage: TokenUsage,
    /** The endpoint's provider in Pi's registry, whose list rates price the models it serves. */
    provider?: string,
  ) => number | undefined;
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
    model: string;
  }): Promise<ProviderCredential | undefined>;
};

const unavailable = (what: string) =>
  new HttpError(401, `${what} is unavailable.`, "invalid_api_key");

/**
 * SelfBench's gateway platform. A request authenticates with a trial key (trial-key.ts). Its
 * solver part pins one model on one of the org's credentials, and a subagent model on its own
 * credential when the run names one: the router is strict, so the gateway serves exactly those
 * (the run's model at the key's thinking level, when it names one) and never falls back or
 * leases. A sign-in serves it on the plan the platform supplies. Its judge part lets the task's
 * judge call any model of its credential's provider (`strict_providers`). Conversation routing
 * state is not kept, since a strict router never reads it.
 */
export function selfBenchPlatform(deps: SelfBenchGatewayDeps): SelfBenchPlatform {
  // The key behind each api_key_id this process resolved, so recordRequest can attribute usage.
  const resolved = new Map<
    string,
    TrialKey & { readonly customEndpoint?: { readonly provider?: string } }
  >();
  const keyOf = (token: string) => {
    const key = readTrialKey(token, deps.secret);
    if (!key)
      throw new HttpError(401, "Invalid or expired SelfBench gateway key.", "invalid_api_key");
    return key;
  };
  return {
    async resolveRouter({ apiKey }: { apiKey: string }) {
      const key = keyOf(apiKey);
      const { model, credentialId, thinking, judge } = key;
      const credential = credentialId && (await deps.credentials.find(key.orgId, credentialId));
      if (credentialId && !credential) throw unavailable("The trial's credential");
      const id = createHash("sha256").update(apiKey).digest("base64url").slice(0, 22);
      const config = model && credential ? modelConfig(deps, key, credential) : undefined;
      const endpoint = credential && credential.kind === "custom" ? credential.endpoint : undefined;
      const registered = model && endpoint ? registryModel(endpoint, model) : undefined;
      // A custom endpoint's model that Pi's registry knows is priced at the registry's list rates.
      const price = model ? (deps.modelPrice?.(model) ?? registered?.cost) : undefined;
      // A pinned level is the only one served, whatever level a call asks for or omits. A custom
      // endpoint's model that Pi's registry knows, which takes no chosen level, is pinned to its
      // own default: every call, Claude Code's too, is served at one level the model lists.
      const pinned = thinking ?? registered?.defaultLevel;
      const subagent = await subagentRouterModel(deps, key);
      const served = [
        ...(model ? [{ model, config, price, pinned }] : []),
        ...(subagent ? [subagent] : []),
      ];
      for (const [stale, entry] of resolved)
        if (entry.expiresAt <= Date.now()) resolved.delete(stale);
      // Any other custom endpoint's call is priced by the model its response names.
      const provider = endpoint ? endpointProvider(endpoint) : undefined;
      resolved.set(
        id,
        credential && credential.kind === "custom" && !registered
          ? { ...key, customEndpoint: provider ? { provider } : {} }
          : key,
      );
      return {
        router_id: ROUTER_ID,
        organization_id: String(key.orgId),
        api_key_id: id,
        attributed_user_id: null,
        enabled_models: served.map((entry) => entry.model),
        provider_keys: {},
        ...routerTables(served),
        strict: true,
        ...(judge ? { strict_providers: [judge.provider] } : {}),
        model_fallback_enabled: false,
        lease_context_enabled: false,
        // Zero data retention would also restrict OpenRouter and Vercel to their ZDR endpoints,
        // which a direct key never was. The gateway keeps no content here either way: Harbor keeps
        // the transcripts, and recordRequest reads only the summary.
        zdr: false,
      };
    },
    async resolveProviderCredential({ apiKey, model }: { apiKey: string; model: string }) {
      const key = keyOf(apiKey);
      // Solver and judge keys are disjoint; each solver model has an exact credential.
      const id = solverCredential(key, model) ?? judgeCredential(key, model);
      if (!id) throw unavailable(`A credential for ${model}`);
      const [info, secret] = await Promise.all([
        deps.credentials.find(key.orgId, id),
        deps.credentials.secret(key.orgId, id),
      ]);
      if (!info || !secret?.value) throw unavailable("The trial's credential");
      // A sign-in is served on its plan, never as an API key.
      const supplied =
        info.auth === "api-key"
          ? { apiKey: secret.value }
          : await signInCredential(
              info,
              secret.value,
              (value) => deps.credentials.renew(key.orgId, id, value),
              deps.captureError,
            );
      if (!supplied) throw unavailable("The trial's sign-in");
      // A Dari or custom credential's own endpoint replaces the provider's.
      if (info.kind === "dari")
        return { ...supplied, baseUrl: dariEndpoint(info.endpoint ?? undefined) };
      return {
        ...supplied,
        ...(info.endpoint ? { baseUrl: customBaseUrl(deps, info.endpoint, key) } : {}),
        // Anthropic's SDK sends the key as x-api-key; compatible endpoints (Shift, Fireworks) take
        // a bearer.
        ...(info.kind === "custom" && messagesEndpoint(key, info.endpoint) && "apiKey" in supplied
          ? { headers: { authorization: `Bearer ${supplied.apiKey}` } }
          : {}),
      };
    },
    async writePrefixState() {},
    async writePendingLease() {},
    async readSessionPin() {
      return null;
    },
    async writeSessionPin() {},
    async markSubscriptionUnavailable() {
      return false;
    },
    async recordUsage() {
      throw new Error("SelfBench's gateway serves only the org's own keys.");
    },
    recordRequest({ summary, tags }: { summary: RequestSummary; tags: Record<string, string> }) {
      const key = summary.api_key_id ? resolved.get(summary.api_key_id) : undefined;
      if (!key) return;
      const model = summary.selected_model ?? key.model ?? "";
      const solver = solverCredential(key, model);
      const credentialId = solver ?? judgeCredential(key, model);
      if (!credentialId) return;
      // Which of the key's models a call is on is the gateway's to say, never a header's.
      const requestTags = { ...tags };
      delete requestTags.judge;
      delete requestTags.subagent;
      // A custom endpoint's call is priced by the model that served it, unless it said its price.
      const cost =
        key.customEndpoint && model === key.model && summary.cost_source !== "provider"
          ? servedCost(deps.servedModelCost, summary, key.customEndpoint.provider)
          : { costUsd: summary.total_cost_usd, costSource: summary.cost_source };
      try {
        deps.recordUsage({
          requestId: summary.request_id,
          orgId: key.orgId,
          credentialId,
          model,
          // The key's tags win: a header can add labels but never reattribute spend.
          tags: {
            ...requestTags,
            ...key.tags,
            ...(solver ? {} : { judge: "true" }),
            ...(key.subagent?.model === model ? { subagent: "true" } : {}),
          },
          status: summary.status,
          inputTokens: summary.input_tokens,
          outputTokens: summary.output_tokens,
          cacheReadTokens: summary.cache_read_tokens,
          cacheWriteTokens: summary.cache_write_tokens,
          // Null when neither the provider nor a known list price priced the call: unpriced.
          ...cost,
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
