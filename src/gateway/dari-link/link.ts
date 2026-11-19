import { randomUUID } from "node:crypto";
import {
  childToken,
  exchange,
  LinkError,
  type LinkTokenSet,
  revoke,
  usage,
} from "@mupt-ai/dari-gateway/link/client";
import { CHATGPT_SIGN_IN_MAX_SANDBOXES } from "../../contracts/config/execution-limits.js";
import { credentialSchema } from "../../db/credentials.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
import type { Vault } from "../../db/vault.js";
import type { TokenUsage } from "../../evaluation/types.js";
import type { GatewayConnection } from "../connection.js";
import type { GatewayUsage } from "../platform.js";
import {
  DARI_API_KEY,
  type DariLinkSecret,
  dariModelId,
  dariRequestName,
  readDariLinkSecret,
} from "./connection.js";

// Connect with Dari, through Dari's Link client: the browser's `DariLink.open` hands SelfBench a
// code and its PKCE verifier, `exchange` redeems them as a confidential client, and the credential
// seals the grant's refresh token. Every later call takes that token; Dari refuses a revoked grant,
// a plan at its limit, or a model the grant cannot serve, and SelfBench shows Dari's error.

/** Dari Link's redirect URI, reached only when the popup lost its opener (credentials.ts). */
export const DARI_LINK_CALLBACK_PATH = "/api/dari-link/callback";

/** SelfBench as a Dari Link app: the Link client's settings. */
export interface DariLinkApp {
  readonly gatewayUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The API's callback, registered with the app; the worker, which sends no one to Dari, has none. */
  readonly redirectUri?: string;
}

/**
 * SelfBench's registration as a confidential Dari Link app, from `SELFBENCH_DARI_LINK_URL`,
 * `SELFBENCH_DARI_LINK_CLIENT_ID` and `SELFBENCH_DARI_LINK_CLIENT_SECRET`; undefined turns Dari
 * Link off. The redirect URI is the public URL's callback, or `SELFBENCH_DARI_LINK_REDIRECT_URI`
 * when registered otherwise (hosted Dari takes only https or localhost ones).
 */
export function dariLinkApp(env: NodeJS.ProcessEnv): DariLinkApp | undefined {
  const gatewayUrl = env.SELFBENCH_DARI_LINK_URL?.trim().replace(/\/+$/, "");
  const clientId = env.SELFBENCH_DARI_LINK_CLIENT_ID?.trim();
  const clientSecret = env.SELFBENCH_DARI_LINK_CLIENT_SECRET?.trim();
  if (!gatewayUrl || !clientId || !clientSecret) return undefined;
  const publicUrl = env.SELFBENCH_PUBLIC_URL?.trim();
  const redirectUri =
    env.SELFBENCH_DARI_LINK_REDIRECT_URI?.trim() ||
    (publicUrl ? new URL(DARI_LINK_CALLBACK_PATH, publicUrl).toString() : undefined);
  return { gatewayUrl, clientId, clientSecret, ...(redirectUri ? { redirectUri } : {}) };
}

/** `Dari · a@example.com`: the run picker lists credentials by name. */
function credentialName(grant: LinkTokenSet): string {
  const which =
    grant.plans.find((plan) => plan.account_email)?.account_email ??
    grant.plans.find((plan) => plan.kind === DARI_API_KEY)?.label;
  return `Dari${which ? ` · ${which}` : ""}`.slice(0, 80);
}

/**
 * Redeems the popup's code and saves the grant as a credential (kind `dari-link`). Every approval is
 * a new grant, so connecting again adds a connection.
 */
export async function connectDari(
  vault: Vault,
  orgId: number,
  app: DariLinkApp,
  approved: { code: string; codeVerifier: string },
): Promise<{ id: string; name: string }> {
  if (!app.redirectUri) throw new RecordStoreError(503, "Dari Link has no redirect URI here.");
  let tokens: LinkTokenSet;
  try {
    tokens = await exchange({ ...app, redirectUri: app.redirectUri, ...approved });
  } catch (error) {
    throw new RecordStoreError(
      error instanceof LinkError && error.status === 400 ? 400 : 502,
      `Dari did not connect: ${(error as Error).message}`,
    );
  }
  const { grantId, plans, models, refreshToken } = tokens;
  try {
    const draft = credentialSchema.parse({
      name: credentialName(tokens),
      kind: "dari-link",
      auth: "dari-link",
      value: JSON.stringify({
        refreshToken,
        grant: { grantId, plans, models },
      } satisfies DariLinkSecret),
      // Plans rate-limit far below API keys.
      ...(plans.some((plan) => plan.kind !== DARI_API_KEY)
        ? { maxSandboxes: CHATGPT_SIGN_IN_MAX_SANDBOXES }
        : {}),
    });
    const created = await vault.credentials.create(orgId, draft, {}, randomUUID());
    return { id: created.id, name: created.name };
  } catch (error) {
    // A grant SelfBench could not save would stay on the user's Dari with nothing here to end it.
    await revoke({ ...app, token: refreshToken }).catch(() => undefined);
    throw error;
  }
}

/** Ends a deleted credential's grant on Dari, so Dari no longer lists SelfBench. */
export async function revokeDari(
  app: DariLinkApp | null | undefined,
  value: string,
): Promise<void> {
  const secret = readDariLinkSecret(value);
  if (app && secret) await revoke({ ...app, token: secret.refreshToken });
}

/** A Dari credential's grant as the Link client's calls take it. */
export type DariLinkGrants = (
  orgId: number,
  credentialId: string,
) => Promise<DariLinkApp & { refreshToken: string }>;

export function dariLinkGrants(
  credentials: Pick<Vault["credentials"], "secret">,
  app: DariLinkApp | undefined,
): DariLinkGrants {
  return async (orgId, credentialId) => {
    if (!app) throw new LinkError("not_configured", "Dari Link is not configured here", 503);
    const value = (await credentials.secret(orgId, credentialId))?.value;
    const secret = value ? readDariLinkSecret(value) : undefined;
    if (!secret) throw new LinkError("not_linked", "The Dari connection is gone", 401);
    return { ...app, refreshToken: secret.refreshToken };
  };
}

/** Dari's refusal as a sentence for the run's error, or undefined when it may pass on retry. */
export function dariRefusal(error: unknown): string | undefined {
  if (!(error instanceof LinkError)) return undefined;
  if (error.code === "not_configured") return "Dari Link is not configured on this worker.";
  if (error.unlinked)
    return "This Dari connection was revoked or expired. Connect again under Credentials.";
  return error.status === 400 || error.status === 403
    ? `Dari refused this model: ${error.message}`
    : undefined;
}

/**
 * A trial's connection to the user's Dari gateway: a child token for its model alone, at its pinned
 * level, tagged with its run and trial, for up to twelve hours. The grant's own token never leaves
 * SelfBench.
 */
export async function dariLinkConnection(
  grants: DariLinkGrants,
  trial: {
    orgId: number;
    credentialId: string;
    /** Dari's model id, `provider/model`. */
    model: string;
    thinking?: string;
    tags: Readonly<Record<string, string>>;
  },
): Promise<GatewayConnection> {
  const grant = await grants(trial.orgId, trial.credentialId);
  const child = await childToken({
    ...grant,
    models: [
      {
        model: dariRequestName(trial.model),
        ...(trial.thinking ? { thinking: trial.thinking } : {}),
      },
    ],
    expiresIn: 43_200,
    tags: { ...trial.tags },
  });
  return {
    openAiBase: `${grant.gatewayUrl}/v1`,
    anthropicBase: grant.gatewayUrl,
    key: child.accessToken,
    host: new URL(grant.gatewayUrl).hostname,
  };
}

/**
 * Copies what Dari recorded a trial's calls using into SelfBench's usage records, one row per model
 * and level at the model's list price, so its cost reads like any gateway trial's. Idempotent.
 */
export async function recordDariLinkUsage(
  grants: DariLinkGrants,
  trial: { orgId: number; credentialId: string; tags: Readonly<Record<string, string>> },
  deps: {
    record: (usage: GatewayUsage) => Promise<void>;
    listCost?: (model: string, usage: TokenUsage) => number | undefined;
  },
): Promise<void> {
  const { orgId, credentialId, tags } = trial;
  const report = await usage({
    ...(await grants(orgId, credentialId)),
    tags: { trial: tags.trial ?? "" },
  });
  for (const entry of report.by_model) {
    const model = dariModelId(entry.model);
    const counts = {
      input: entry.input_tokens,
      output: entry.output_tokens,
      cacheRead: entry.cache_read_tokens,
      cacheWrite: entry.cache_write_tokens,
    };
    const cost = deps.listCost?.(model, counts);
    await deps.record({
      requestId: `dari-link:${tags.trial}:${model}:${entry.thinking ?? ""}`,
      orgId,
      credentialId,
      model,
      tags: { ...tags },
      status: "completed",
      inputTokens: counts.input,
      outputTokens: counts.output,
      cacheReadTokens: counts.cacheRead,
      cacheWriteTokens: counts.cacheWrite,
      costUsd: cost ?? null,
      costSource: cost === undefined ? null : "pricing",
    });
  }
}
