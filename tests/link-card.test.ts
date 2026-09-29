import { expect, test } from "bun:test";
import { costRange } from "../src/api/link-card.js";

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
