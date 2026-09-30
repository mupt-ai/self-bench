import { afterEach, expect, test } from "bun:test";
import { billingServer } from "./support/billing-server.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

test("checkout refuses a Stripe price whose meter units do not equal displayed dollars", async () => {
  const server = await billingServer("0.000001");
  stop = server.stop;
  const response = await server.request("/api/orgs/team/billing/checkout", {
    method: "POST",
    headers: {
      origin: "http://billing.test",
      "content-type": "application/json",
      "x-user": "owner",
    },
    body: "{}",
  });
  expect(response.status).toBe(503);
  expect(server.stripeCalls).not.toContain("POST https://api.stripe.com/v1/checkout/sessions");
});

test("checkout rejects a correctly priced but unrelated meter", async () => {
  const server = await billingServer("0.00001", "unrelated_meter");
  stop = server.stop;
  const response = await server.request("/api/orgs/team/billing/checkout", {
    method: "POST",
    headers: {
      origin: "http://billing.test",
      "content-type": "application/json",
      "x-user": "owner",
    },
    body: "{}",
  });
  expect(response.status).toBe(503);
  expect(server.stripeCalls).not.toContain("POST https://api.stripe.com/v1/checkout/sessions");
});

test("ambiguous Stripe response retries with the same idempotency key", async () => {
  const server = await billingServer();
  stop = server.stop;
  await server.store.saveCustomer(server.teamId, "cus_1");
  server.dropCreditResponseOnce();
  const body = JSON.stringify({
    targetOrg: "team",
    amountCents: 100,
    reason: "Retry safely",
    requestId: crypto.randomUUID(),
  });
  const headers = {
    origin: "http://billing.test",
    "content-type": "application/json",
    "x-user": "owner",
  };
  const path = "/api/orgs/mupt-ai/billing/credits";
  expect((await server.request(path, { method: "POST", headers, body })).status).toBe(500);
  expect((await server.request(path, { method: "POST", headers, body })).status).toBe(200);
  expect(server.credits).toHaveLength(2);
  expect(server.credits[1]?.key).toBe(server.credits[0]?.key);
  expect((await server.request(path, { method: "POST", headers, body })).status).toBe(200);
  expect(server.credits).toHaveLength(2);
});

test("only mupt-ai browser admins can grant Stripe invoice credits to existing customers", async () => {
  const server = await billingServer();
  stop = server.stop;
  // Registered team has a Stripe customer; grants must not create new customers.
  await server.store.saveCustomer(server.teamId, "cus_1");
  const body = JSON.stringify({
    targetOrg: "TEAM",
    amountCents: 1234,
    reason: "Courtesy",
    requestId: crypto.randomUUID(),
  });
  const headers = {
    origin: "http://billing.test",
    "content-type": "application/json",
    "x-user": "owner",
  };
  const grant = await server.request("/api/orgs/mupt-ai/billing/credits", {
    method: "POST",
    headers,
    body,
  });
  expect(grant.status).toBe(200);
  expect(server.credits[0]?.body.get("amount")).toBe("-1234");
  expect(server.credits[0]?.body.get("currency")).toBe("usd");
  const retry = await server.request("/api/orgs/mupt-ai/billing/credits", {
    method: "POST",
    headers,
    body,
  });
  expect(retry.status).toBe(200);
  expect((await retry.json()).replay).toBe(true);
  expect(server.credits).toHaveLength(1);
  const reusedId = await server.request("/api/orgs/mupt-ai/billing/credits", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...JSON.parse(body), amountCents: 1235 }),
  });
  expect(reusedId.status).toBe(409);
  expect(server.credits).toHaveLength(1);
  for (const [path, changedHeaders, changedBody] of [
    ["/api/orgs/team/billing/credits", headers, body],
    ["/api/orgs/mupt-ai/billing/credits", { ...headers, "x-user": "member" }, body],
    ["/api/orgs/mupt-ai/billing/credits", { ...headers, origin: "https://evil.example" }, body],
    [
      "/api/orgs/mupt-ai/billing/credits",
      headers,
      JSON.stringify({
        targetOrg: "team",
        amountCents: -1,
        reason: "Bad",
        requestId: crypto.randomUUID(),
      }),
    ],
  ] as const) {
    const denied = await server.request(path, {
      method: "POST",
      headers: changedHeaders,
      body: changedBody,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  }
  expect(server.credits).toHaveLength(1);
  const overDailyLimit = await server.request("/api/orgs/mupt-ai/billing/credits", {
    method: "POST",
    headers,
    body: JSON.stringify({
      targetOrg: "team",
      amountCents: 8_767,
      reason: "Over daily budget",
      requestId: crypto.randomUUID(),
    }),
  });
  expect(overDailyLimit.status).toBe(429);
  expect(server.credits).toHaveLength(1);
  server.setGitHubRole("member");
  const revokedAdmin = await server.request("/api/orgs/mupt-ai/billing/credits", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...JSON.parse(body), requestId: crypto.randomUUID() }),
  });
  expect(revokedAdmin.status).toBe(403);
  expect(server.credits).toHaveLength(1);
});
