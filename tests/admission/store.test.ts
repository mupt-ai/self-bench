import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { type AdmissionRequest, createAdmissionStore } from "../../src/db/admissions.js";
import { sandboxAdmissions } from "../../src/db/schema.js";
import { testDatabase } from "../support/site-fixture.js";

const request = (
  id: string,
  pool = "e2b:managed",
  orgId = "1",
  kind: AdmissionRequest["kind"] = "agent",
): AdmissionRequest => ({
  id,
  pool,
  orgId,
  kind,
  workflowId: `workflow-${id}`,
  workflowRunId: "run",
});

test("a pool admits up to its limit, then serves waiters oldest first as slots free", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    expect(await store.acquire(request("a"), { pool: 2, org: {} })).toBe(true);
    expect(await store.acquire(request("b"), { pool: 2, org: {} })).toBe(true);
    expect(await store.acquire(request("c"), { pool: 2, org: {} })).toBe(false);
    expect(await store.acquire(request("d"), { pool: 2, org: {} })).toBe(false);
    // A retried poll by a holder never takes a second slot.
    expect(await store.acquire(request("a"), { pool: 2, org: {} })).toBe(true);
    // Pools are independent provider accounts.
    expect(await store.acquire(request("other", "modal:managed"), { pool: 1, org: {} })).toBe(true);

    await store.release("a");
    expect(await store.acquire(request("d"), { pool: 2, org: {} })).toBe(false);
    expect(await store.acquire(request("c"), { pool: 2, org: {} })).toBe(true);
    expect(await store.acquire(request("d"), { pool: 2, org: {} })).toBe(false);
    await store.release("b");
    expect(await store.acquire(request("d"), { pool: 2, org: {} })).toBe(true);
  } finally {
    await database.close();
  }
});

test("expired holders and waiters that stopped polling free their place", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    expect(await store.acquire(request("leaked"), { pool: 1, org: {} })).toBe(true);
    expect(await store.acquire(request("gone"), { pool: 1, org: {} })).toBe(false);
    expect(await store.acquire(request("next"), { pool: 1, org: {} })).toBe(false);
    await database.db.execute(
      sql`update sandbox_admissions set expires_at = now() - interval '1 second' where id in ('leaked', 'gone')`,
    );
    expect(await store.acquire(request("next"), { pool: 1, org: {} })).toBe(true);
  } finally {
    await database.close();
  }
});

test("a freed slot goes to the organization holding the fewest, not the oldest waiter", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    const limits = { pool: 3, org: {} };
    const big = (id: string) => request(id, "e2b:managed", "big");
    for (const id of ["b1", "b2", "b3"]) expect(await store.acquire(big(id), limits)).toBe(true);
    for (const id of ["b4", "b5"]) expect(await store.acquire(big(id), limits)).toBe(false);
    const small = request("s1", "e2b:managed", "small");
    expect(await store.acquire(small, limits)).toBe(false);

    await store.release("b1");
    // b4 has waited longest, but the small organization holds nothing.
    expect(await store.acquire(big("b4"), limits)).toBe(false);
    expect(await store.acquire(small, limits)).toBe(true);
    await store.release("b2");
    expect(await store.acquire(big("b5"), limits)).toBe(false);
    expect(await store.acquire(big("b4"), limits)).toBe(true);
  } finally {
    await database.close();
  }
});

test("per-organization caps leave room for others and never block other waiters", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    const limits = { pool: 10, org: { agent: 2 } };
    expect(await store.acquire(request("a1", "e2b:managed", "a"), limits)).toBe(true);
    expect(await store.acquire(request("a2", "e2b:managed", "a"), limits)).toBe(true);
    // The cap counts across pools.
    expect(await store.acquire(request("a3", "e2b:deployment", "a"), limits)).toBe(false);
    // A capped organization's older waiter does not hold back another organization.
    expect(await store.acquire(request("b1", "e2b:deployment", "b"), limits)).toBe(true);
  } finally {
    await database.close();
  }
});

test("Harbor capacity is shared across pools; per-organization Harbor caps apply", async () => {
  const database = await testDatabase();
  try {
    const store = createAdmissionStore(database.db);
    const limits = { org: { harbor: 1 }, harbor: 2 };
    const harbor = (id: string, pool: string, org: string) => request(id, pool, org, "harbor");
    expect(await store.acquire(harbor("a1", "modal:managed", "a"), limits)).toBe(true);
    expect(await store.acquire(harbor("a2", "modal:managed", "a"), limits)).toBe(false);
    expect(await store.acquire(harbor("b1", "modal:credential:x", "b"), limits)).toBe(true);
    expect(await store.acquire(harbor("c1", "modal:managed", "c"), limits)).toBe(false);
    // Agents never count against Harbor capacity.
    expect(await store.acquire(request("c2", "e2b:managed", "c"), { org: {} })).toBe(true);
    await store.release("b1");
    expect(await store.acquire(harbor("c1", "modal:managed", "c"), limits)).toBe(true);
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
    expect(await store.acquire(request("cancelled"), { pool: 1, org: {} })).toBe(true);
    expect(await store.acquire(request("waiting"), { pool: 1, org: {} })).toBe(false);
    await store.release("cancelled", true);
    await store.release("waiting", true);
    // The drained slot still counts; the waiter simply left the queue.
    expect(await expiry("waiting")).toBeUndefined();
    expect(await expiry("cancelled")).toBeCloseTo(70 * 60, -2);
    expect(await store.acquire(request("next"), { pool: 1, org: {} })).toBe(false);
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
    expect(await store.acquire(request("held"), { pool: 2, org: {} })).toBe(true);
    expect(await store.acquire(request("other"), { pool: 2, org: {} })).toBe(true);
    expect(await store.holders()).toHaveLength(2);
    await store.drainEnded("workflow-held", "run");
    expect(await store.holders()).toEqual([{ workflowId: "workflow-other", workflowRunId: "run" }]);
  } finally {
    await database.close();
  }
});
