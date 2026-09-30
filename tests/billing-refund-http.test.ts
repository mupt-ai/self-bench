import { afterEach, expect, test } from "bun:test";
import { billingOutbox } from "../src/db/schema.js";
import { createUsageStore } from "../src/db/usage.js";
import { billingServer } from "./support/billing-server.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

test("mupt-ai admins refund an org's billed usage in its open period once", async () => {
  const server = await billingServer();
  stop = server.stop;
  await server.store.saveCustomer(server.teamId, "cus_1");
  await server.store.applyWebhook(
    { id: "evt_1", type: "customer.subscription.created" },
    { customerId: "cus_1", subscriptionId: "sub_1", status: "active", cancelAtPeriodEnd: false },
  );
  const usage = createUsageStore(server.database.db);
  const sandboxRun = {
    orgId: server.teamId,
    stage: "author",
    managed: true,
    managedModel: false,
    managedSandbox: true,
    sandboxSeconds: 10,
  };
  await usage.record({ ...sandboxRun, runId: "batch-before", sandboxId: "sb-before" });
  // Usage from a closed period stays billed.
  await server.database.db.update(billingOutbox).set({ createdAt: new Date(1_789_000_000_000) });
  await usage.record({ ...sandboxRun, runId: "batch-open", sandboxId: "sb-open" });
  const headers = {
    origin: "http://billing.test",
    "content-type": "application/json",
    "x-user": "owner",
  };
  const body = JSON.stringify({ targetOrg: "team", reason: "Beta usage" });
  const path = "/api/orgs/mupt-ai/billing/refunds";
  for (const [deniedPath, deniedHeaders] of [
    [path, { ...headers, "x-user": "member" }],
    ["/api/orgs/team/billing/refunds", headers],
  ] as const) {
    const denied = await server.request(deniedPath, {
      method: "POST",
      headers: deniedHeaders,
      body,
    });
    expect(denied.ok).toBe(false);
  }
  const refund = await server.request(path, { method: "POST", headers, body });
  expect(await refund.json()).toEqual({ refundedUsd: 0.00092 });
  expect(server.stripeCalls).toContain("GET https://api.stripe.com/v1/subscriptions/sub_1");
  const again = await server.request(path, { method: "POST", headers, body });
  expect(await again.json()).toEqual({ refundedUsd: 0 });
  const status = await (await server.request("/api/orgs/team/billing", { headers })).json();
  expect(status.usage.billedUsd).toBeCloseTo(0.00184, 8);
  expect(status.usage.refundedUsd).toBeCloseTo(0.00092, 8);
});
