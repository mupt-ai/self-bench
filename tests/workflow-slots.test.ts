import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createWorkflowSlots } from "../src/db/workflow-slots.js";
import { workflowSlotLimit } from "../src/generation/pipeline/workflow-slots.js";
import { testDatabase } from "./support/site-fixture.js";

test("slots go first come, first served up to the platform limit", async () => {
  const database = await testDatabase();
  try {
    const slots = createWorkflowSlots(database.db, 2);
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
    const slots = createWorkflowSlots(database.db, 1);
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

test("the platform limit defaults to 100", () => {
  expect(workflowSlotLimit({})).toBe(100);
  expect(workflowSlotLimit({ SELFBENCH_WORKFLOW_LIMIT: "40" })).toBe(40);
  expect(() => workflowSlotLimit({ SELFBENCH_WORKFLOW_LIMIT: "0" })).toThrow();
});
