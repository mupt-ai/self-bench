import type { IncomingMessage } from "node:http";

/** Tokens a caller holds, refilled continuously up to a burst. */
interface Bucket {
  tokens: number;
  updatedAt: number;
  /** When this client's refusal was last reported. */
  reportedAt?: number;
}

export interface RateLimitOptions {
  /** Sustained requests a minute per client. */
  perMinute: number;
  /** Requests a client may make at once before the sustained rate applies. */
  burst: number;
  /** Sustained requests a minute across every client: the backstop for a flood from many IPs. */
  globalPerMinute: number;
  globalBurst: number;
  /** Told of a refused client at most once a minute each, so limits can be tuned from real use. */
  onLimit?: (client: string, scope: "client" | "global") => void;
  now?: () => number;
}

/** Either allowed, or refused with the seconds to wait. */
export type RateLimitVerdict = { ok: true } | { ok: false; retryAfter: number };

/** Buckets idle this long are dropped, so the table does not grow with every visitor ever seen. */
const IDLE_MS = 10 * 60_000;

/**
 * Token buckets per client IP, plus one shared by all clients. In process: one API server
 * serves both sites, so a limit here protects the app from load on the public site.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const now = options.now ?? Date.now;
  const clients = new Map<string, Bucket>();
  const everyone: Bucket = { tokens: options.globalBurst, updatedAt: now() };
  let sweptAt = now();
  const refill = (bucket: Bucket, perMinute: number, burst: number, at: number) => {
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.updatedAt) * perMinute) / 60_000);
    bucket.updatedAt = at;
  };
  const wait = (bucket: Bucket, perMinute: number) =>
    Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / perMinute));
  return {
    take(client: string): RateLimitVerdict {
      const at = now();
      if (at - sweptAt > IDLE_MS) {
        for (const [key, bucket] of clients)
          if (at - bucket.updatedAt > IDLE_MS) clients.delete(key);
        sweptAt = at;
      }
      const bucket = clients.get(client) ?? { tokens: options.burst, updatedAt: at };
      clients.set(client, bucket);
      refill(bucket, options.perMinute, options.burst, at);
      refill(everyone, options.globalPerMinute, options.globalBurst, at);
      const refuse = (scope: "client" | "global", retryAfter: number): RateLimitVerdict => {
        if (bucket.reportedAt === undefined || at - bucket.reportedAt >= 60_000) {
          bucket.reportedAt = at;
          options.onLimit?.(client, scope);
        }
        return { ok: false, retryAfter };
      };
      if (bucket.tokens < 1) return refuse("client", wait(bucket, options.perMinute));
      if (everyone.tokens < 1) return refuse("global", wait(everyone, options.globalPerMinute));
      bucket.tokens -= 1;
      everyone.tokens -= 1;
      return { ok: true };
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * The client's IP. In production the API listens on loopback behind Caddy, which sets
 * `X-Forwarded-For` to the real peer and drops any value the client sent, so the last entry is
 * trustworthy. Without the header, the socket's address.
 */
export function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  const last = header?.split(",").at(-1)?.trim();
  return last || request.socket.remoteAddress || "unknown";
}
