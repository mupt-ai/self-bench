/**
 * The transitions show and hide pages in blocks and dots through clip paths, rebuilt every
 * frame. A clip path takes effect in the frame it is set. A canvas mask (`mask-image` from a
 * data URL, redrawn every frame) does not in WebKit, the engine of every iPhone browser: it
 * loads each new image asynchronously and draws the element fully hidden until it has, so the
 * page went blank for as long as an effect ran, then appeared at once.
 */

/** Hides the whole element. */
export const HIDDEN = "inset(50%)";

/** A clip path made of rectangles in the element's own pixels: what they cover shows. */
export function clipRects() {
  let path = "";
  const short = (value: number) => Math.round(value * 100) / 100;
  return {
    add(x: number, y: number, width: number, height: number) {
      if (width <= 0 || height <= 0) return;
      // All drawn the same way round, so overlapping rectangles add up rather than cancel.
      path += `M${short(x)} ${short(y)}h${short(width)}v${short(height)}h${short(-width)}z`;
    },
    /** The CSS value; hides everything when no rectangle was added. */
    css: () => (path ? `path("${path}")` : HIDDEN),
  };
}

interface Run {
  left: number;
  top: number;
  length: number;
}

/**
 * A clip path made of square cells of `cell` pixels, given row by row as runs of cells that
 * show. A run exactly under one in the row above extends it down rather than starting another,
 * so a solid area is one rectangle however many rows it spans.
 */
export function clipCells(cell: number) {
  const shown = clipRects();
  let above = new Map<number, Run>();
  let row = new Map<number, Run>();
  let y = 0;
  const close = (runs: Map<number, Run>) => {
    for (const run of runs.values())
      shown.add(run.left * cell, run.top * cell, run.length * cell, (y - run.top) * cell);
  };
  return {
    /** Cells `left` up to (not including) `right` of the current row show. */
    run(left: number, right: number) {
      const key = left * 65_536 + right;
      row.set(key, above.get(key) ?? { left, top: y, length: right - left });
      above.delete(key);
    },
    /** Moves on to the next row. */
    endRow() {
      // Runs with nothing under them end here.
      close(above);
      above = row;
      row = new Map();
      y += 1;
    },
    /** The CSS value, once every row has been given. */
    css() {
      close(above);
      above = new Map();
      return shown.css();
    },
  };
}
