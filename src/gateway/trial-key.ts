import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ThinkingLevel } from "../contracts/models.js";

/** The credential id of SelfBench's own OpenRouter account (managed model access). */
export const MANAGED_MODEL_CREDENTIAL = "managed-model";

/** A thinking level the gateway pins a trial's model to: any but the provider default. */
const pinnedLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];
export type PinnedThinking = (typeof pinnedLevels)[number];

/**
 * What one trial's agent may call through the gateway, signed by the worker and checked by the
 * API with a secret both share (as callback-grant.ts does), so nothing is stored server-side. It
 * names one credential and the one model it may serve, which the gateway pins (`strict`).
 */
export interface TrialKey {
  readonly orgId: number;
  readonly credentialId: string;
  /** The gateway's model id, `provider/model`, such as `openrouter/anthropic/claude-sonnet-5-5`. */
  readonly model: string;
  /**
   * The thinking level every call is served at, when the trial's harness does not say it on each
   * request itself (Codex's is dropped by the gateway). Absent, each call's own level is served.
   */
  readonly thinking?: PinnedThinking;
  /** Attribution for the requests it makes, recorded with their usage and cost. */
  readonly tags: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

const keySchema = z.object({
  orgId: z.number().int(),
  credentialId: z.union([z.uuid(), z.literal(MANAGED_MODEL_CREDENTIAL)]),
  model: z.string().regex(/^[^/\s]+\/\S+$/),
  thinking: z.enum(pinnedLevels).optional(),
  tags: z.record(z.string(), z.string()),
  expiresAt: z.number(),
});

const PREFIX = "sbk_";

export function signTrialKey(key: TrialKey, secret: string): string {
  const payload = Buffer.from(JSON.stringify(key)).toString("base64url");
  return `${PREFIX}${payload}.${signature(payload, secret)}`;
}

/** The key a token carries; undefined when it is malformed, forged, or expired. */
export function readTrialKey(
  token: string,
  secret: string,
  now = Date.now(),
): TrialKey | undefined {
  if (!token.startsWith(PREFIX)) return undefined;
  const [payload, mac, ...rest] = token.slice(PREFIX.length).split(".");
  if (!payload || !mac || rest.length > 0) return undefined;
  const expected = Buffer.from(signature(payload, secret));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const { thinking, ...key } = keySchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    return key.expiresAt > now ? { ...key, ...(thinking ? { thinking } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
