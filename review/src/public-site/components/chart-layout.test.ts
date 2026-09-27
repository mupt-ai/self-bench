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
  // Rebuild each label's text box from its anchor (6.6px per character, 14px tall).
  const boxes = placed.map((label) => {
    const width = (points.find((point) => point.id === label.id)?.label.length ?? 0) * 6.6;
    const left =
      label.anchor === "start"
        ? label.x
        : label.anchor === "end"
          ? label.x - width
          : label.x - width / 2;
    return { left, right: left + width, top: label.y - 12, bottom: label.y + 3 };
  });
  const markers = points.map(({ x, y }) => ({
    left: x - 5,
    right: x + 5,
    top: y - 5,
    bottom: y + 5,
  }));
  const intersects = (one: (typeof boxes)[number], two: (typeof boxes)[number]) =>
    one.left < two.right && two.left < one.right && one.top < two.bottom && two.top < one.bottom;
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) expect(intersects(box, other)).toBe(false);
    for (const marker of markers) expect(intersects(box, marker)).toBe(false);
  }
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
