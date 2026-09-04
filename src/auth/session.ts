import { constantTimeEqual, deriveKey, hmacSign } from "./crypto.js";

export const SESSION_COOKIE = "selfbench_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** What the cookie carries: enough to find the user, nothing a browser could use elsewhere. */
export interface SessionClaims {
  readonly githubId: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SessionSigner {
  /** Returns the cookie value for a fresh 30-day session. */
  issue(githubId: number): string;
  /** Returns the claims when the value is well formed, signed by us, and unexpired. */
  verify(value: string | undefined): SessionClaims | undefined;
}

interface Wire {
  readonly v: 1;
  readonly uid: number;
  readonly iat: number;
  readonly exp: number;
}

/**
 * Stateless signed cookie: `base64url(json) . base64url(hmac-sha256)`. Rotating the secret
 * signs everyone out; there is no server-side session row to revoke.
 */
export function createSessionSigner(
  secret: string,
  options: { now?: () => Date; ttlSeconds?: number } = {},
): SessionSigner {
  const key = deriveKey(secret, "session-signing");
  const now = options.now ?? (() => new Date());
  const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS;
  return {
    issue(githubId) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const wire: Wire = { v: 1, uid: githubId, iat: issuedAt, exp: issuedAt + ttl };
      const payload = Buffer.from(JSON.stringify(wire)).toString("base64url");
      return `${payload}.${hmacSign(key, payload)}`;
    },
    verify(value) {
      if (!value) return undefined;
      const separator = value.indexOf(".");
      if (separator <= 0) return undefined;
      const payload = value.slice(0, separator);
      const signature = value.slice(separator + 1);
      if (!constantTimeEqual(signature, hmacSign(key, payload))) return undefined;
      const wire = decode(payload);
      if (!wire) return undefined;
      if (wire.exp <= Math.floor(now().getTime() / 1000)) return undefined;
      return { githubId: wire.uid, issuedAt: wire.iat, expiresAt: wire.exp };
    },
  };
}

function decode(payload: string): Wire | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const wire = parsed as Partial<Wire>;
    if (
      wire.v !== 1 ||
      !Number.isSafeInteger(wire.uid) ||
      !Number.isSafeInteger(wire.iat) ||
      !Number.isSafeInteger(wire.exp)
    ) {
      return undefined;
    }
    return { v: 1, uid: wire.uid as number, iat: wire.iat as number, exp: wire.exp as number };
  } catch {
    return undefined;
  }
}
