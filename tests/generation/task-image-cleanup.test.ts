import { expect, test } from "bun:test";
import type { TaskImages } from "../../src/contracts/index.js";
import { cleanupKeeps, type ReviewedTask } from "../../src/generation/tasks/task-images.js";

const pair = (agent: string, verifier: string): TaskImages => ({
  agent: `registry.example/tasks/agent@sha256:${agent.repeat(64)}`,
  verifier: `registry.example/tasks/verifier@sha256:${verifier.repeat(64)}`,
});
const digest = (character: string) => `sha256:${character.repeat(64)}`;

test("a check's cleanup keeps its own pair, the row's current pair, and what is pinned elsewhere", async () => {
  // Another check of the row recorded its pair after this one read the row.
  const recorded = pair("a", "b");
  const rows = {
    find: async () => ({ images: recorded }) as ReviewedTask,
    referenced: async (digests: readonly string[]) => digests.includes(digest("e")),
  };
  const keeps = await cleanupKeeps(rows, { id: 7 }, pair("c", "d"));
  for (const kept of ["a", "b", "c", "d", "e"]) expect(await keeps(digest(kept))).toBe(true);
  expect(await keeps(digest("f"))).toBe(false);
});

test("without a pair of its own, a failed check deletes all but what the row records", async () => {
  const rows = {
    find: async () => ({ images: pair("a", "b") }) as ReviewedTask,
    referenced: async () => false,
  };
  const keeps = await cleanupKeeps(rows, { id: 7 });
  expect(await keeps(digest("a"))).toBe(true);
  expect(await keeps(digest("c"))).toBe(false);
});
