import { expect, test } from "bun:test";
import type { PublicTask } from "./contract";
import { resultsGrid } from "./results-grid";
import { setting } from "./test-fixture";

const settings = [
  setting({ id: "cheap", accuracy: 50, costPerTaskUsd: 0.5 }),
  setting({ id: "best", accuracy: 100, costPerTaskUsd: 3 }),
  setting({ id: "dear", accuracy: 50, costPerTaskUsd: 2 }),
];
const task = (id: string, passed?: Record<string, boolean>): PublicTask => ({
  id,
  difficulty: "medium",
  ...(passed ? { passed } : {}),
});

test("settings run from most accurate to cheapest, and tasks from most solved to least", () => {
  const grid = resultsGrid(settings, [
    task("hard", { best: true, cheap: false, dear: false }),
    task("easy", { best: true, cheap: true, dear: true }),
    task("tied-first", { best: true, cheap: true, dear: false }),
    task("tied-second", { best: true, cheap: false, dear: true }),
  ]);
  expect(grid?.settings.map((entry) => entry.id)).toEqual(["best", "cheap", "dear"]);
  expect(grid?.tasks.map((entry) => entry.id)).toEqual([
    "easy",
    "tied-first",
    "tied-second",
    "hard",
  ]);
});

test("tasks without results draw no grid", () => {
  expect(resultsGrid(settings, [task("a"), task("b")])).toBeUndefined();
  expect(resultsGrid(settings, [])).toBeUndefined();
});
