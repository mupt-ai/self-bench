import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { type AdmissionRequest, createAdmissionStore } from "../../src/db/admissions.js";
import { sandboxAdmissions } from "../../src/db/schema.js";
import { testDatabase } from "../support/site-fixture.js";

const request = (id: string, pool = "e2b:managed"): AdmissionRequest => ({
  id,
  pool,
  orgId: "1",
  kind: "agent",
  workflowId: `workflow-${id}`,
  workflowRunId: "run",
});

test("a pool admits up to its limit, then serves waiters oldest first as slots free", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    expect(await store.acquire(request("a"), 2)).toBe(true);
    expect(await store.acquire(request("b"), 2)).toBe(true);
    expect(await store.acquire(request("c"), 2)).toBe(false);
    expect(await store.acquire(request("d"), 2)).toBe(false);
    // A retried poll by a holder never takes a second slot.
    expect(await store.acquire(request("a"), 2)).toBe(true);
    // Pools are independent provider accounts.
    expect(await store.acquire(request("other", "modal:managed"), 1)).toBe(true);

    await store.release("a");
    expect(await store.acquire(request("d"), 2)).toBe(false);
    expect(await store.acquire(request("c"), 2)).toBe(true);
    expect(await store.acquire(request("d"), 2)).toBe(false);
    await store.release("b");
    expect(await store.acquire(request("d"), 2)).toBe(true);
  } finally {
    await database.close();
  }
});

test("expired holders and waiters that stopped polling free their place", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    expect(await store.acquire(request("leaked"), 1)).toBe(true);
    expect(await store.acquire(request("gone"), 1)).toBe(false);
    expect(await store.acquire(request("next"), 1)).toBe(false);
    await database.db.execute(
      sql`update sandbox_admissions set expires_at = now() - interval '1 second' where id in ('leaked', 'gone')`,
    );
    expect(await store.acquire(request("next"), 1)).toBe(true);
  } finally {
    await database.close();
  }
});

test("a stage that ended abnormally keeps its slot until its sandbox has certainly stopped", async () => {
  const database = await testDatabase();
  const expiry = async (id: string) => {
    const [row] = await database.db
      .select({ seconds: sql<string>`extract(epoch from ${sandboxAdmissions.expiresAt} - now())` })
      .from(sandboxAdmissions)
      .where(eq(sandboxAdmissions.id, id));
    return row ? Number(row.seconds) : undefined;
  };
  try {
    const store = createAdmissionStore(database.db);
    expect(await store.acquire(request("cancelled"), 1)).toBe(true);
    expect(await store.acquire(request("waiting"), 1)).toBe(false);
    await store.release("cancelled", true);
    await store.release("waiting", true);
    // The drained slot still counts; the waiter simply left the queue.
    expect(await expiry("waiting")).toBeUndefined();
    expect(await expiry("cancelled")).toBeCloseTo(70 * 60, -2);
    expect(await store.acquire(request("next"), 1)).toBe(false);
    // Draining never extends an already draining slot.
    await store.release("cancelled", true);
    expect(await expiry("cancelled")).toBeLessThanOrEqual(70 * 60);
  } finally {
    await database.close();
  }
});

test("executions holding undrained slots are listed and can be drained", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    expect(await store.acquire(request("held"), 2)).toBe(true);
    expect(await store.acquire(request("other"), 2)).toBe(true);
    expect(await store.holders()).toHaveLength(2);
    await store.drainEnded("workflow-held", "run");
    expect(await store.holders()).toEqual([{ workflowId: "workflow-other", workflowRunId: "run" }]);
  } finally {
    await database.close();
  }
});
