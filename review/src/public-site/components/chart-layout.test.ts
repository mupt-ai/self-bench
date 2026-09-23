import { expect, test } from "bun:test";
import { nearest, niceTicks, placeLabels } from "./chart-layout";

test("ticks are round and cover the maximum", () => {
  expect(niceTicks(4.37, 5)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(niceTicks(0.9, 3)).toEqual([0, 0.5, 1]);
  expect(niceTicks(0)).toEqual([0]);
});

test("labels never overlap and frontier labels are placed first", () => {
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  const points = [
    { id: "a", x: 100, y: 100, label: "Low Priority Model", priority: 0 },
    { id: "b", x: 104, y: 102, label: "Frontier Model", priority: 1 },
    { id: "c", x: 300, y: 200, label: "Alone", priority: 0 },
  ];
  const placed = placeLabels(points, bounds);
  expect(placed[0]?.id).toBe("b");
  expect(placed.map((label) => label.id)).toContain("c");
  const ids = new Set(placed.map((label) => label.id));
  expect(ids.size).toBe(placed.length);
});

test("labels stay inside the plot, flipping to the left near the right edge", () => {
  const placed = placeLabels([{ id: "edge", x: 390, y: 150, label: "Near Edge", priority: 1 }], {
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  });
  expect(placed[0]?.anchor).toBe("end");
});

test("hover picks the nearest point within reach, or nothing", () => {
  const points = [
    { id: "a", x: 10, y: 10 },
    { id: "b", x: 50, y: 50 },
  ];
  expect(nearest(points, { x: 45, y: 44 })?.id).toBe("b");
  expect(nearest(points, { x: 200, y: 200 })).toBeUndefined();
});
