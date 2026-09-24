import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { type AdmissionRequest, createAdmissionStore } from "../../src/db/admissions.js";
import { testDatabase } from "../support/site-fixture.js";

const request = (id: string, pool = "e2b:managed"): AdmissionRequest => ({
  id,
  pool,
  orgId: "1",
  kind: "agent",
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
