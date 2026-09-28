import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { clientIp, createRateLimiter } from "../src/api/rate-limit.js";

const clock = () => {
  let at = 0;
  return { now: () => at, advance: (ms: number) => (at += ms) };
};

test("a client gets its burst, then the sustained rate, then a wait", () => {
  const time = clock();
  const limiter = createRateLimiter({ perMinute: 60, burst: 3, now: time.now });
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

test("no limit is shared: many clients at once are each held to their own share", () => {
  const time = clock();
  const limiter = createRateLimiter({ perMinute: 60, burst: 2, now: time.now });
  for (let index = 0; index < 1_000; index += 1) {
    expect(limiter.take(`client-${index}`).ok).toBe(true);
    expect(limiter.take(`client-${index}`).ok).toBe(true);
  }
  expect(limiter.take("client-0").ok).toBe(false);
});

test("refusals are reported at most once a minute per client", () => {
  const time = clock();
  const reports: string[] = [];
  const limiter = createRateLimiter({
    perMinute: 60,
    burst: 1,
    onLimit: (client) => reports.push(client),
    now: time.now,
  });
  limiter.take("a");
  limiter.take("a");
  limiter.take("a");
  expect(reports).toEqual(["a"]);
  time.advance(61_000);
  limiter.take("a");
  limiter.take("a");
  expect(reports).toEqual(["a", "a"]);
});

test("the client is the address the load balancer appended, else the socket's", () => {
  const request = (headers: Record<string, string | string[]>, remote = "10.0.0.1") =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
  expect(clientIp(request({ "x-forwarded-for": "203.0.113.9, 34.120.0.1" }))).toBe("203.0.113.9");
  expect(clientIp(request({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 34.120.0.1" }))).toBe(
    "203.0.113.9",
  );
  expect(clientIp(request({}))).toBe("10.0.0.1");
});
