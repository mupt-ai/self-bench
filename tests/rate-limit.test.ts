import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { clientIp, createRateLimiter } from "../src/api/rate-limit.js";

const clock = () => {
  let at = 0;
  return { now: () => at, advance: (ms: number) => (at += ms) };
};

test("a client gets its burst, then the sustained rate, then a wait", () => {
  const time = clock();
  const limiter = createRateLimiter({
    perMinute: 60,
    burst: 3,
    globalPerMinute: 6_000,
    globalBurst: 600,
    now: time.now,
  });
  for (let index = 0; index < 3; index += 1) expect(limiter.take("a").ok).toBe(true);
  const refused = limiter.take("a");
  expect(refused).toEqual({ ok: false, retryAfter: 1 });
  // Another client is unaffected.
  expect(limiter.take("b").ok).toBe(true);
  // One token a second comes back.
  time.advance(1_000);
  expect(limiter.take("a").ok).toBe(true);
  expect(limiter.take("a").ok).toBe(false);
});

test("the shared limit stops a flood spread across many clients", () => {
  const time = clock();
  const limiter = createRateLimiter({
    perMinute: 600,
    burst: 100,
    globalPerMinute: 60,
    globalBurst: 5,
    now: time.now,
  });
  const verdicts = Array.from({ length: 8 }, (_, index) => limiter.take(`client-${index}`).ok);
  expect(verdicts.filter(Boolean)).toHaveLength(5);
});

test("refusals are reported at most once a minute per client", () => {
  const time = clock();
  const reports: string[] = [];
  const limiter = createRateLimiter({
    perMinute: 60,
    burst: 1,
    globalPerMinute: 6_000,
    globalBurst: 600,
    onLimit: (client, scope) => reports.push(`${client}:${scope}`),
    now: time.now,
  });
  limiter.take("a");
  limiter.take("a");
  limiter.take("a");
  expect(reports).toEqual(["a:client"]);
  time.advance(61_000);
  limiter.take("a");
  limiter.take("a");
  expect(reports).toEqual(["a:client", "a:client"]);
});

test("the client is the last forwarded address, else the socket's", () => {
  const request = (headers: Record<string, string | string[]>, remote = "10.0.0.1") =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
  expect(clientIp(request({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  expect(clientIp(request({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }))).toBe("203.0.113.9");
  expect(clientIp(request({}))).toBe("10.0.0.1");
});

test("behind Google's load balancer the client is the second-to-last address", () => {
  const request = (forwarded: string) =>
    ({
      headers: { "x-forwarded-for": forwarded },
      socket: { remoteAddress: "169.254.1.1" },
    }) as unknown as IncomingMessage;
  // The load balancer appends the client it saw, then its own address; earlier entries are spoofable.
  expect(clientIp(request("203.0.113.9, 34.120.0.1"), 2)).toBe("203.0.113.9");
  expect(clientIp(request("6.6.6.6, 203.0.113.9, 34.120.0.1"), 2)).toBe("203.0.113.9");
});
