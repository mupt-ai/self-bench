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
  /** Told of a refused client at most once a minute each, so limits can be tuned from real use. */
  onLimit?: (client: string) => void;
  now?: () => number;
}

/** Either allowed, or refused with the seconds to wait. */
export type RateLimitVerdict = { ok: true } | { ok: false; retryAfter: number };

/** Buckets idle this long are dropped, so the table does not grow with every visitor ever seen. */
const IDLE_MS = 10 * 60_000;

/**
 * Token buckets per client IP, in process. One client over its share is refused; nobody else
 * is. There is deliberately no limit shared by all clients: tripping one would refuse every
 * visitor at once, the worst outcome of a spike. The CDN absorbs repeated requests, and public
 * responses come from memory, so load on the public site does not reach the app's database.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const now = options.now ?? Date.now;
  const clients = new Map<string, Bucket>();
  let sweptAt = now();
  const refill = (bucket: Bucket, at: number) => {
    bucket.tokens = Math.min(
      options.burst,
      bucket.tokens + ((at - bucket.updatedAt) * options.perMinute) / 60_000,
    );
    bucket.updatedAt = at;
  };
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
      refill(bucket, at);
      if (bucket.tokens < 1) {
        if (bucket.reportedAt === undefined || at - bucket.reportedAt >= 60_000) {
          bucket.reportedAt = at;
          options.onLimit?.(client);
        }
        return {
          ok: false,
          retryAfter: Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / options.perMinute)),
        };
      }
      bucket.tokens -= 1;
      return { ok: true };
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * The client's IP. In production the API runs on Cloud Run behind Google's load balancer, which
 * appends the client it saw and then its own address to `X-Forwarded-For`, so the second-to-last
 * entry is trustworthy; anything earlier came from the client. Without it, the socket's address.
 */
export function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  return header?.split(",").at(-2)?.trim() || request.socket.remoteAddress || "unknown";
}
