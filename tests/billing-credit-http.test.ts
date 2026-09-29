import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { sendApiError } from "../src/api/http.js";
import { createBillingRoutes } from "../src/api/routes/billing.js";
import { createBillingStore } from "../src/db/billing.js";
import { createUserStore } from "../src/db/users.js";
import { testAuthConfig, testDatabase } from "./support/site-fixture.js";

const stripe = {
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  priceId: "price_metered",
  apiVersion: "2025-09-30.clover" as const,
};

async function billingServer(
  priceUnitCents = "0.00001",
  meterEventName = "selfbench_managed_usage",
) {
  const database = await testDatabase();
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const admin = await users.upsert({
    githubId: 1,
    login: "owner",
    token: "gho",
    scopes: "",
    orgs: [
      { githubId: 2, login: "team", role: "admin" },
      { githubId: 4, login: "mupt-ai", role: "admin" },
    ],
  });
  const member = await users.upsert({
    githubId: 3,
    login: "member",
    token: "gho",
    scopes: "",
    orgs: [{ githubId: 2, login: "team", role: "member" }],
  });
  const store = createBillingStore(database.db, true);
  const teamId = (await users.orgsFor(admin.id)).find((org) => org.login === "team")?.id;
  if (!teamId) throw new Error("team missing");
  const stripeCalls: string[] = [];
  let githubRole: string = "admin";
  let dropCreditResponseOnce = false;
  const credits: { body: URLSearchParams; key: string | null }[] = [];
  const routes = createBillingRoutes({
    users,
    store,
    config: stripe,
    publicUrl: "http://billing.test",
    creditAdminOrgId: 4,
    githubApiUrl: "https://api.github.test",
    githubToken: async () => "gho_admin",
    fetchImpl: (async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.github.test/user/memberships/orgs")) {
        return Response.json([{ role: githubRole, organization: { id: 4, login: "mupt-ai" } }]);
      }
      stripeCalls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/prices/price_metered"))
        return Response.json({
          active: true,
          currency: "usd",
          billing_scheme: "per_unit",
          recurring: { usage_type: "metered", meter: "mtr_1" },
          unit_amount_decimal: priceUnitCents,
        });
      if (url.endsWith("/v1/customers/cus_1/balance_transactions")) {
        credits.push({
          body: new URLSearchParams(String(init?.body)),
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        if (dropCreditResponseOnce) {
          dropCreditResponseOnce = false;
          throw new Error("simulated lost Stripe response");
        }
        return Response.json({ id: "cbtxn_1" });
      }
      if (url.endsWith("/v1/billing/meters/mtr_1"))
        return Response.json({
          event_name: meterEventName,
          status: "active",
          default_aggregation: { formula: "sum" },
          customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
          value_settings: { event_payload_key: "value" },
        });
      if (url.endsWith("/v1/customers")) return Response.json({ id: "cus_1" });
      if (url.endsWith("/v1/checkout/sessions"))
        return Response.json({ url: "https://checkout.stripe.test/c" });
      if (url.endsWith("/v1/billing_portal/sessions"))
        return Response.json({ url: "https://billing.stripe.test/p" });
      return new Response("missing", { status: 404 });
    }) as typeof fetch,
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://billing.test");
      const login = request.headers["x-user"];
      const user = login === "member" ? member : login === "owner" ? admin : undefined;
      if (await routes.webhook(request, url, response)) return;
      if (!user) {
        response.writeHead(401).end();
        return;
      }
      if (!(await routes.handle(request, url, response, user))) response.writeHead(404).end();
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const request = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, init);
  return {
    store,
    teamId,
    stripeCalls,
    credits,
    setGitHubRole: (role: string) => {
      githubRole = role;
    },
    dropCreditResponseOnce: () => {
      dropCreditResponseOnce = true;
    },
    request,
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await database.close();
    },
  };
}

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
