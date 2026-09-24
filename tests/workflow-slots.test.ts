import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createWorkflowSlots } from "../src/db/workflow-slots.js";
import { workflowSlotLimits } from "../src/generation/pipeline/workflow-slots.js";
import { testDatabase } from "./support/site-fixture.js";

test("slots go first come, first served up to the platform limit", async () => {
  const database = await testDatabase();
  try {
    const slots = createWorkflowSlots(database.db, { total: 2, perOrg: 2 });
    expect(await slots.acquire("a1", "a")).toBe(true);
    expect(await slots.acquire("a2", "a")).toBe(true);
    expect(await slots.acquire("b1", "b")).toBe(false);
    expect(await slots.acquire("c1", "c")).toBe(false);
    // A retried poll by a holder never takes a second slot.
    expect(await slots.acquire("a1", "a")).toBe(true);

    await slots.release("a1", false);
    // b1 arrived before c1.
    expect(await slots.acquire("c1", "c")).toBe(false);
    expect(await slots.acquire("b1", "b")).toBe(true);
    await slots.release("a2", false);
    expect(await slots.acquire("c1", "c")).toBe(true);
  } finally {
    await database.close();
  }
});

test("an abnormal release keeps the slot draining; expired rows free their place", async () => {
  const database = await testDatabase();
  try {
    const slots = createWorkflowSlots(database.db, { total: 1, perOrg: 1 });
    expect(await slots.acquire("held", "a")).toBe(true);
    expect(await slots.acquire("waiting", "b")).toBe(false);
    await slots.release("held", true);
    expect(await slots.acquire("waiting", "b")).toBe(false);
    await database.db.execute(
      sql`update workflow_slots set expires_at = now() - interval '1 second' where id = 'held'`,
    );
    expect(await slots.acquire("waiting", "b")).toBe(true);
  } finally {
    await database.close();
  }
});

test("an organization at its limit is skipped without blocking later waiters", async () => {
  const database = await testDatabase();
  try {
    const slots = createWorkflowSlots(database.db, { total: 3, perOrg: 2 });
    expect(await slots.acquire("a1", "a")).toBe(true);
    expect(await slots.acquire("a2", "a")).toBe(true);
    expect(await slots.acquire("a3", "a")).toBe(false);
    expect(await slots.acquire("b1", "b")).toBe(true);
    expect(await slots.acquire("c1", "c")).toBe(false);
    await slots.release("a1", false);
    // a3 arrived before c1 and a is under its limit again.
    expect(await slots.acquire("c1", "c")).toBe(false);
    expect(await slots.acquire("a3", "a")).toBe(true);
  } finally {
    await database.close();
  }
});

test("limits default to 100 workflows and 20 per organization", () => {
  expect(workflowSlotLimits({})).toEqual({ total: 100, perOrg: 20 });
  expect(workflowSlotLimits({ SELFBENCH_ORG_WORKFLOW_LIMIT: "5" }).perOrg).toBe(5);
  expect(() => workflowSlotLimits({ SELFBENCH_WORKFLOW_LIMIT: "0" })).toThrow();
});
