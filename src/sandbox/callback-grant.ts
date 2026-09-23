import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { StartedSandbox } from "./contracts.js";

/**
 * What a started sandbox may do through the callback API, signed by the worker and checked by
 * the API with a secret both share. It names one Temporal activity attempt, the one artifact
 * folder the job may write, and the sandbox itself, so nothing is stored server-side.
 */
export interface SandboxGrant {
  /** The activity attempt's Temporal task token, base64. */
  readonly taskToken: string;
  /** Artifact key prefix every upload lands under. */
  readonly prefix: string;
  readonly sandbox: StartedSandbox;
  readonly expiresAt: number;
}

const grantSchema = z.object({
  taskToken: z.string().min(1),
  prefix: z.string().min(1),
  sandbox: z.object({
    sandboxId: z.string().min(1),
    stage: z.string().min(1),
    startedAt: z.string().min(1),
    expiresAt: z.string().min(1),
    cpu: z.number().optional(),
    memoryMiB: z.number().optional(),
    rates: z
      .object({
        model: z.string().optional(),
        sandboxProvider: z.enum(["docker", "e2b", "modal", "vercel"]).optional(),
      })
      .optional(),
  }),
  expiresAt: z.number(),
});

export function signSandboxGrant(grant: SandboxGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

/** The grant a token carries; undefined when it is malformed, forged, or expired. */
export function readSandboxGrant(
  token: string,
  secret: string,
  now = Date.now(),
): SandboxGrant | undefined {
  const [payload, mac, ...rest] = token.split(".");
  if (!payload || !mac || rest.length > 0) return undefined;
  const expected = Buffer.from(signature(payload, secret));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const grant = grantSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    return grant.expiresAt > now ? (grant as SandboxGrant) : undefined;
  } catch {
    return undefined;
  }
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
