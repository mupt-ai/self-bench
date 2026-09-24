import { describe, expect, test } from "bun:test";
import { clipCells, clipRects, HIDDEN } from "./clip";

describe("clipRects", () => {
  test("joins rectangles into one path, all drawn the same way round", () => {
    const shape = clipRects();
    shape.add(0, 0, 10, 20);
    shape.add(5.123, 1, 2, 3);
    expect(shape.css()).toBe('path("M0 0h10v20h-10zM5.12 1h2v3h-2z")');
  });

  test("hides everything when nothing shows", () => {
    const shape = clipRects();
    shape.add(0, 0, 0, 10);
    expect(shape.css()).toBe(HIDDEN);
  });
});

describe("clipCells", () => {
  test("grows a run down while the rows below repeat it", () => {
    const cells = clipCells(3);
    for (let row = 0; row < 3; row++) {
      cells.run(0, 4);
      cells.endRow();
    }
    expect(cells.css()).toBe('path("M0 0h12v9h-12z")');
  });

  test("starts a new rectangle where a run changes", () => {
    const cells = clipCells(3);
    cells.run(0, 4);
    cells.endRow();
    cells.run(0, 2);
    cells.run(3, 4);
    cells.endRow();
    expect(cells.css()).toBe('path("M0 0h12v3h-12zM0 3h6v3h-6zM9 3h3v3h-3z")');
  });

  test("skips rows with nothing in them", () => {
    const cells = clipCells(2);
    cells.run(1, 2);
    cells.endRow();
    cells.endRow();
    cells.run(1, 2);
    cells.endRow();
    expect(cells.css()).toBe('path("M2 0h2v2h-2zM2 4h2v2h-2z")');
  });
});
