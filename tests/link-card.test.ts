import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { costRange, costTicks } from "../src/api/link-card.js";

const costs = (...values: number[]) => values.map((costPerTaskUsd) => ({ costPerTaskUsd }));

test("the preview's cost axis runs from low to high even when every cost is $0", () => {
  const [low, high] = costRange(costs(0, 0));
  expect(low).toBeLessThan(high);
  expect(10 ** low).toBeLessThan(1);
  expect(10 ** high).toBeGreaterThan(1);
});

test("the preview's cost axis spans the costs themselves, with a little room each side", () => {
  const [low, high] = costRange(costs(2, 0, 5));
  expect(10 ** low).toBeCloseTo(2 / 1.3, 6);
  expect(10 ** high).toBeCloseTo(5 * 1.3, 6);
});

test("the preview's cost axis always has numbers, even for one price or a tight cluster", () => {
  expect(costTicks(costs(3))).toEqual([3]);
  expect(costTicks(costs(3, 3.4))).toEqual([3, 3.4]);
  expect(costTicks(costs(0.12, 0.45, 5.1))).toEqual([0.1, 0.2, 0.5, 1, 2, 5]);
  expect(costTicks(costs(0, 0))).toEqual([1]);
});

test("the preview finds its fonts from any working directory", () => {
  // A fresh process started elsewhere, as a server can be: the fonts are found beside the module.
  const module = new URL("../src/api/link-card.ts", import.meta.url).pathname;
  const script = `
    const { cardPng } = await import(${JSON.stringify(module)});
    const png = cardPng({
      releaseId: "r", releasedAt: "2026-09-01T00:00:00Z", schemaVersion: 1,
      repository: { id: 1, fullName: "owner/name" }, publisher: { login: "someone", kind: "user" },
      tasks: 3, settings: [], frontier: [],
    });
    console.log(png.length);
  `;
  const run = Bun.spawnSync(["bun", "-e", script], { cwd: tmpdir() });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  expect(Number(run.stdout.toString())).toBeGreaterThan(10_000);
});
