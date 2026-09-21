import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createUserStore } from "../src/auth/users.js";
import { loadBillingPolicy } from "../src/billing/config.js";
import { startBillingDispatcher } from "../src/billing/outbox.js";
import {
  modelBillableUnits,
  rateSnapshotSpec,
  sandboxBillableUnits,
} from "../src/billing/policy.js";
import { createBillingStore } from "../src/billing/store.js";
import { billingOutbox, generationUsage } from "../src/db/schema.js";
import { createUsageStore } from "../src/managed/usage-store.js";
import { testAuthConfig, testDatabase } from "./support/site-fixture.js";

async function orgFixture() {
  const database = await testDatabase();
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const user = await users.upsert({
    githubId: 1,
    login: "owner",
    token: "gho",
    scopes: "",
    orgs: [{ githubId: 2, login: "team", role: "admin" }],
  });
  const org = (await users.orgsFor(user.id)).find((item) => item.login === "team");
  if (!org) throw new Error("org missing");
  return { database, org };
}

const managedRow = {
  runId: "batch-1",
  stage: "author",
  managed: true,
  managedModel: true,
  managedSandbox: true,
  model: "gpt-5.6-sol",
  tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
  sandboxSeconds: 10,
  cpu: 4,
  memoryMiB: 8192,
  modelCostUsd: 2,
  sandboxCostUsd: 0.00092,
};

test("managed usage snapshots integer units and only enqueues when a Stripe customer exists", async () => {
  const { database, org } = await orgFixture();
  try {
    const usage = createUsageStore(database.db);
    await usage.record({ ...managedRow, orgId: org.id });
    const [row] = await database.db.select().from(generationUsage);
    const snapshot = rateSnapshotSpec(loadBillingPolicy({}));
    expect(row?.rateSnapshotId).toBeGreaterThan(0);
    expect(row?.modelBillableUnits).toBe(
      modelBillableUnits(snapshot, "gpt-5.6-sol", managedRow.tokens),
    );
    expect(row?.sandboxBillableUnits).toBe(sandboxBillableUnits(snapshot, 10, 4, 8192));
    expect(await database.db.select().from(billingOutbox)).toEqual([]);

    await createBillingStore(database.db, true).saveCustomer(org.id, "cus_test");
    const { tokens: _tokens, ...sandboxOnly } = managedRow;
    await usage.record({ ...sandboxOnly, runId: "batch-2", orgId: org.id, managedModel: false });
    const queued = await database.db.select().from(billingOutbox);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.identifier).toBe(`selfbench-usage-${queued[0]?.usageId}`);
    expect(queued[0]?.value).toBe(sandboxBillableUnits(snapshot, 10, 4, 8192));
    expect(queued[0]?.customerId).toBe("cus_test");
  } finally {
    await database.close();
  }
});

test("user-credential usage is never billed and Stripe delivery is independent of recording", async () => {
  const { database, org } = await orgFixture();
  try {
    const billing = createBillingStore(database.db, true);
    await billing.saveCustomer(org.id, "cus_test");
    const usage = createUsageStore(database.db);
    await usage.record({
      runId: "batch-byok",
      orgId: org.id,
      stage: "author",
      managed: false,
      managedModel: false,
      managedSandbox: false,
      sandboxSeconds: 12,
    });
    const [row] = await database.db.select().from(generationUsage);
    expect(row?.rateSnapshotId).toBeNull();
    expect(row?.modelBillableUnits).toBe(0);
    expect(row?.sandboxBillableUnits).toBe(0);
    expect(await database.db.select().from(billingOutbox)).toEqual([]);

    await usage.record({ ...managedRow, orgId: org.id });
    const calls: string[] = [];
    const dispatcher = startBillingDispatcher(
      billing,
      {
        secretKey: "sk_test",
        webhookSecret: "whsec",
        priceId: "price_1",
        apiVersion: "2025-03-31.basil",
      },
      {
        intervalMs: 60_000,
        fetchImpl: (async (input, init) => {
          calls.push(`${init?.method ?? "GET"} ${String(input)}`);
          expect(new Headers(init?.headers).get("idempotency-key")).toStartWith("selfbench-usage-");
          const body = JSON.parse(String(init?.body)) as {
            identifier: string;
            payload: { value: string };
          };
          expect(body.payload.value).toMatch(/^[0-9]+$/);
          return Response.json({ identifier: body.identifier });
        }) as typeof fetch,
      },
    );
    dispatcher.wake();
    await dispatcher.close();
    expect(calls).toEqual(["POST https://api.stripe.com/v2/billing/meter_events"]);
    const [sent] = await database.db.select().from(billingOutbox);
    expect(sent?.status).toBe("sent");
    expect(sent?.sentAt).toBeInstanceOf(Date);
  } finally {
    await database.close();
  }
});

test("failed meter delivery is retried without duplicating the Stripe identifier", async () => {
  const { database, org } = await orgFixture();
  try {
    const billing = createBillingStore(database.db, true);
    await billing.saveCustomer(org.id, "cus_test");
    await createUsageStore(database.db).record({ ...managedRow, orgId: org.id });
    let attempts = 0;
    const send = startBillingDispatcher(
      billing,
      {
        secretKey: "sk_test",
        webhookSecret: "whsec",
        priceId: "price_1",
        apiVersion: "2025-03-31.basil",
      },
      {
        intervalMs: 60_000,
        fetchImpl: (async () => {
          attempts += 1;
          return new Response("nope", { status: 500 });
        }) as unknown as typeof fetch,
      },
    );
    send.wake();
    await send.close();
    expect(attempts).toBe(1);
    const [failed] = await database.db.select().from(billingOutbox);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    await database.db
      .update(billingOutbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(billingOutbox.id, failed?.id ?? 0));
    const retry = startBillingDispatcher(
      billing,
      {
        secretKey: "sk_test",
        webhookSecret: "whsec",
        priceId: "price_1",
        apiVersion: "2025-03-31.basil",
      },
      {
        intervalMs: 60_000,
        fetchImpl: (async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { identifier: string };
          expect(body.identifier).toBe(failed?.identifier ?? "missing");
          return Response.json({ identifier: body.identifier });
        }) as typeof fetch,
      },
    );
    retry.wake();
    await retry.close();
    expect((await database.db.select().from(billingOutbox))[0]?.status).toBe("sent");
  } finally {
    await database.close();
  }
});
