import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { sendApiError } from "../src/api/http.js";
import { createBillingRoutes } from "../src/api/routes/billing.js";
import { createBillingStore } from "../src/db/billing.js";
import { createUserStore } from "../src/db/users.js";
import { fixture, ROOT } from "./support/batch-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { testAuthConfig, testDatabase } from "./support/site-fixture.js";

const stripe = {
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  priceId: "price_metered",
  apiVersion: "2025-09-30.clover" as const,
};

function sign(body: Buffer) {
  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", stripe.webhookSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

async function billingServer(priceUnitCents = "0.00001") {
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
  const credits: { body: URLSearchParams; key: string | null }[] = [];
  const routes = createBillingRoutes({
    users,
    store,
    config: stripe,
    publicUrl: "http://billing.test",
    fetchImpl: (async (input, init) => {
      const url = String(input);
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
        return Response.json({ id: "cbtxn_1" });
      }
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

test("admins can start Checkout and the portal; members only read status", async () => {
  const server = await billingServer();
  stop = server.stop;
  const jsonHeaders = {
    origin: "http://billing.test",
    "content-type": "application/json",
    "x-user": "owner",
  };
  const status = await (
    await server.request("/api/orgs/team/billing", { headers: { "x-user": "owner" } })
  ).json();
  expect(status).toMatchObject({
    configured: true,
    eligible: false,
    status: "none",
    canManage: true,
  });
  const checkout = await server.request("/api/orgs/team/billing/checkout", {
    method: "POST",
    headers: jsonHeaders,
    body: "{}",
  });
  expect(await checkout.json()).toEqual({ url: "https://checkout.stripe.test/c" });
  expect(server.stripeCalls.some((call) => call.endsWith("/v1/customers"))).toBe(true);
  const portal = await server.request("/api/orgs/team/billing/portal", {
    method: "POST",
    headers: jsonHeaders,
    body: "{}",
  });
  expect(await portal.json()).toEqual({ url: "https://billing.stripe.test/p" });
  expect(
    (
      await server.request("/api/orgs/team/billing/checkout", {
        method: "POST",
        headers: { ...jsonHeaders, "x-user": "member" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await server.request("/api/orgs/team/billing/checkout", {
        method: "POST",
        headers: { ...jsonHeaders, origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
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

test("only mupt-ai browser admins can grant Stripe invoice credits to existing customers", async () => {
  const server = await billingServer();
  stop = server.stop;
  // Registered team has a Stripe customer; grants must not create new customers.
  await server.store.saveCustomer(server.teamId, "cus_1");
  const body = JSON.stringify({
    targetOrg: "team",
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
  expect(server.credits[1]?.key).toBe(server.credits[0]?.key);
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
  expect(server.credits).toHaveLength(2);
});

test("signed webhooks update subscription state and ignore duplicates", async () => {
  const server = await billingServer();
  stop = server.stop;
  await server.store.saveCustomer(1, "cus_1");
  const payload = Buffer.from(
    JSON.stringify({
      id: "evt_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          cancel_at_period_end: false,
          current_period_end: 1_800_000_000,
        },
      },
    }),
  );
  const headers = { "stripe-signature": sign(payload), "content-type": "application/json" };
  expect(
    (await server.request("/api/stripe/webhook", { method: "POST", headers, body: payload }))
      .status,
  ).toBe(200);
  expect(await server.store.status(1)).toMatchObject({
    configured: true,
    eligible: true,
    status: "active",
    subscriptionId: "sub_1",
  });
  const replay = await server.request("/api/stripe/webhook", {
    method: "POST",
    headers,
    body: payload,
  });
  expect(replay.status).toBe(200);
  expect(
    (
      await server.request("/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=dead", "content-type": "application/json" },
        body: payload,
      })
    ).status,
  ).toBe(400);
});

test("managed generation is gated when Stripe is configured and unblocked for credentials", async () => {
  const previous = {
    models: process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY,
    sandbox: process.env.SELFBENCH_MANAGED_E2B_API_KEY,
  };
  process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY = "platform-openrouter";
  process.env.SELFBENCH_MANAGED_E2B_API_KEY = "platform-e2b";
  try {
    const vault = memoryVault();
    const f = await fixture({ vault, billing: true });
    const managed = {
      authorModel: "gpt-6-sol",
      verifierModel: "gpt-6-sol",
      reasoning: "high",
      modelAccess: "managed",
      sandbox: "managed",
    };
    const refused = await f.request(ROOT, {
      method: "POST",
      body: JSON.stringify({
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        generation: managed,
      }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "billing_required" });
    expect(f.started).toHaveLength(0);
    const model = await vault.credentials.create(
      f.tenant.id,
      { name: "OpenAI", kind: "openai", auth: "api-key", value: "sk-own-key" },
      {},
    );
    const e2b = await vault.credentials.create(
      f.tenant.id,
      { name: "E2B", kind: "e2b", auth: "api-key", value: "own-e2b-key" },
      {},
    );
    const allowed = await f.request(ROOT, {
      method: "POST",
      body: JSON.stringify({
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        generation: {
          ...managed,
          modelAccess: "credential",
          modelCredentialId: model.id,
          sandbox: "e2b",
          sandboxCredentialId: e2b.id,
          harborEnvironment: "e2b",
          harborCredentialId: e2b.id,
        },
      }),
    });
    expect(allowed.status).toBe(202);
  } finally {
    if (previous.models === undefined) delete process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY;
    else process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY = previous.models;
    if (previous.sandbox === undefined) delete process.env.SELFBENCH_MANAGED_E2B_API_KEY;
    else process.env.SELFBENCH_MANAGED_E2B_API_KEY = previous.sandbox;
  }
});
