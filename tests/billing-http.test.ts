import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { fixture, ROOT } from "./support/batch-fixture.js";
import { billingServer, stripe } from "./support/billing-server.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { clearMockModels, mockReferenceModelsAsListed } from "./support/model-catalog.js";

beforeEach(mockReferenceModelsAsListed);
afterEach(clearMockModels);

function sign(body: Buffer) {
  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", stripe.webhookSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

for (const [name, priceUnitCents, meterEventName] of [
  ["a Stripe price whose meter units do not equal displayed dollars", "0.000001", undefined],
  ["a correctly priced but unrelated meter", "0.00001", "unrelated_meter"],
] as const) {
  test(`checkout refuses ${name}`, async () => {
    const server = await billingServer(priceUnitCents, meterEventName);
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
}

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
    offering: process.env.SELFBENCH_MANAGED_OFFERING,
    models: process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY,
    sandbox: process.env.SELFBENCH_MANAGED_E2B_API_KEY,
  };
  process.env.SELFBENCH_MANAGED_OFFERING = "true";
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
    if (previous.offering === undefined) delete process.env.SELFBENCH_MANAGED_OFFERING;
    else process.env.SELFBENCH_MANAGED_OFFERING = previous.offering;
    if (previous.models === undefined) delete process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY;
    else process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY = previous.models;
    if (previous.sandbox === undefined) delete process.env.SELFBENCH_MANAGED_E2B_API_KEY;
    else process.env.SELFBENCH_MANAGED_E2B_API_KEY = previous.sandbox;
  }
});
