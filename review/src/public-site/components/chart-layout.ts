/** Pure geometry for the results chart: scales, ticks, label placement, nearest point. */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placed {
  id: string;
  x: number;
  y: number;
  anchor: "start" | "end" | "middle";
}

/** Round tick values covering [0, max]. */
export function niceTicks(max: number, count = 5): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 0.001; value += step)
    ticks.push(Number(value.toFixed(6)));
  if ((ticks.at(-1) ?? 0) < max) ticks.push(Number(((ticks.at(-1) ?? 0) + step).toFixed(6)));
  return ticks;
}

const overlaps = (a: Box, b: Box, pad = 2) =>
  a.x < b.x + b.width + pad &&
  b.x < a.x + a.width + pad &&
  a.y < b.y + b.height + pad &&
  b.y < a.y + a.height + pad;

/**
 * Greedy label placement. Points are tried in priority order (frontier first); each tries
 * right, left, above, below. A label that fits nowhere is left out; its point keeps its
 * hover card. Boxes around every point are reserved so labels never cover a marker.
 */
export function placeLabels(
  points: { id: string; x: number; y: number; label: string; priority: number }[],
  bounds: Box,
  charWidth = 6.6,
  height = 14,
): Placed[] {
  const taken: Box[] = points.map((point) => ({
    x: point.x - 5,
    y: point.y - 5,
    width: 10,
    height: 10,
  }));
  const placed: Placed[] = [];
  const ordered = [...points].sort((left, right) => right.priority - left.priority);
  for (const point of ordered) {
    const width = point.label.length * charWidth;
    const candidates: [Box, Placed][] = [
      [
        { x: point.x + 8, y: point.y - height / 2, width, height },
        { id: point.id, x: point.x + 8, y: point.y + 4, anchor: "start" },
      ],
      [
        { x: point.x - 8 - width, y: point.y - height / 2, width, height },
        { id: point.id, x: point.x - 8, y: point.y + 4, anchor: "end" },
      ],
      [
        { x: point.x - width / 2, y: point.y - 8 - height, width, height },
        { id: point.id, x: point.x, y: point.y - 10, anchor: "middle" },
      ],
      [
        { x: point.x - width / 2, y: point.y + 8, width, height },
        { id: point.id, x: point.x, y: point.y + 8 + height - 3, anchor: "middle" },
      ],
    ];
    for (const [box, label] of candidates) {
      const inside =
        box.x >= bounds.x &&
        box.y >= bounds.y &&
        box.x + box.width <= bounds.x + bounds.width &&
        box.y + box.height <= bounds.y + bounds.height;
      if (inside && !taken.some((other) => overlaps(box, other))) {
        taken.push(box);
        placed.push(label);
        break;
      }
    }
  }
  return placed;
}

/** The point closest to the cursor, if within reach. Makes small markers easy to hover. */
export function nearest<T extends { x: number; y: number }>(
  points: readonly T[],
  cursor: { x: number; y: number },
  reach = 36,
): T | undefined {
  let best: T | undefined;
  let bestDistance = reach * reach;
  for (const point of points) {
    const distance = (point.x - cursor.x) ** 2 + (point.y - cursor.y) ** 2;
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}
