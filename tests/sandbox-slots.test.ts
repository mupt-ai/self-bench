import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createSandboxSlots } from "../src/db/sandbox-slots.js";
import { sandboxSlotLimits } from "../src/generation/pipeline/sandbox-slots.js";
import { testDatabase } from "./support/site-fixture.js";

test("slots go first come, first served, skipping organizations at their limit", async () => {
  const database = await testDatabase();
  try {
    const slots = createSandboxSlots(database.db, { total: 3, perOrg: 2 });
    expect(await slots.acquire("a1", "a")).toBe(true);
    expect(await slots.acquire("a2", "a")).toBe(true);
    // Org a is at its limit; b is admitted past a's older waiter.
    expect(await slots.acquire("a3", "a")).toBe(false);
    expect(await slots.acquire("b1", "b")).toBe(true);
    // The platform is full.
    expect(await slots.acquire("b2", "b")).toBe(false);
    expect(await slots.acquire("c1", "c")).toBe(false);
    // A retried poll by a holder never takes a second slot.
    expect(await slots.acquire("a1", "a")).toBe(true);

    await slots.release("a1", false);
    // a3 arrived first and a is under its limit again.
    expect(await slots.acquire("c1", "c")).toBe(false);
    expect(await slots.acquire("b2", "b")).toBe(false);
    expect(await slots.acquire("a3", "a")).toBe(true);
    await slots.release("b1", false);
    expect(await slots.acquire("c1", "c")).toBe(false);
    expect(await slots.acquire("b2", "b")).toBe(true);
  } finally {
    await database.close();
  }
});

test("an abnormal release keeps the slot draining; expired rows free their place", async () => {
  const database = await testDatabase();
  try {
    const slots = createSandboxSlots(database.db, { total: 1, perOrg: 1 });
    expect(await slots.acquire("held", "a")).toBe(true);
    expect(await slots.acquire("waiting", "b")).toBe(false);
    await slots.release("held", true);
    expect(await slots.acquire("waiting", "b")).toBe(false);
    await database.db.execute(
      sql`update sandbox_slots set expires_at = now() - interval '1 second' where id = 'held'`,
    );
    expect(await slots.acquire("waiting", "b")).toBe(true);
  } finally {
    await database.close();
  }
});

test("limits default to 100 total and 20 per organization", () => {
  expect(sandboxSlotLimits({})).toEqual({ total: 100, perOrg: 20 });
  expect(sandboxSlotLimits({ SELFBENCH_ORG_SANDBOX_LIMIT: "5" }).perOrg).toBe(5);
  expect(() => sandboxSlotLimits({ SELFBENCH_SANDBOX_LIMIT: "0" })).toThrow();
});
