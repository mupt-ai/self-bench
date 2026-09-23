import { resolveRgb } from "./color";
import { bayer } from "./dither";
import { currentTransition, stillRunning } from "./transition-run";

/** Size of one dither dot, in CSS pixels. */
const CELL = 3;
/**
 * Width, in dots, of the band where holes open up behind the burning front. Kept narrow, so
 * large text is consumed soon after the front reaches it instead of staying readable.
 */
const HOLE_BAND = 16;
/** Width, in dots, of the scorched band ahead of the holes; darkest next to them. */
const CHAR_BAND = 30;
const DURATION_MS = 1250;
/** How long the paper over a `keepClear` area takes to dissolve: quick, close to a swap. */
const KEEP_FADE_MS = 100;
/** Most the burning edge wanders from a clean outline, in dots. */
const RAGGED = 9;

/** A rectangle in the sheet's own coordinates, in CSS pixels. */
export interface Origin {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Smooth random offsets, so the burning edge is ragged rather than a clean outline. */
function raggedness(width: number, height: number, scale: number, amount: number): Float32Array {
  const columns = Math.ceil(width / scale) + 2;
  const lattice = Array.from({ length: columns * (Math.ceil(height / scale) + 2) }, Math.random);
  const at = (column: number, row: number) => lattice[row * columns + column] ?? 0;
  const offsets = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / scale);
    const fy = y / scale - row;
    for (let x = 0; x < width; x++) {
      const column = Math.floor(x / scale);
      const fx = x / scale - column;
      const top = at(column, row) * (1 - fx) + at(column + 1, row) * fx;
      const bottom = at(column, row + 1) * (1 - fx) + at(column + 1, row + 1) * fx;
      offsets[y * width + x] = (top * (1 - fy) + bottom * fy) * amount;
    }
  }
  return offsets;
}

/** The scorch colour: the theme's --scorch token, the same colour as the background water. */
function scorch(): [number, number, number, number] {
  const [red, green, blue] = resolveRgb("var(--scorch)");
  return [red, green, blue, document.documentElement.dataset.theme === "dark" ? 70 : 100];
}

export interface BurnOptions {
  /** A point (sheet coordinates) the fire runs faster toward, the more so the farther it is. */
  toward?: { x: number; y: number };
  /** Burn from the far edges in, reaching `origin` last, instead of outwards from it. */
  inward?: boolean;
  /**
   * An area (sheet coordinates) that is never scorched: the paper over it dissolves (dithered)
   * as soon as the burn starts drawing, before the fire itself arrives.
   */
  keepClear?: Origin;
  /** How long the whole burn takes. */
  duration?: number;
  /** Prepare now but wait for `start()`, so callers can time the fire against other motion. */
  hold?: boolean;
}

export interface Burn {
  /** Milliseconds after the fire starts at which `area` has burned fully through. */
  clearedAt(area: Origin): number;
  /** Milliseconds after the fire starts at which it first touches `area` (its scorch band). */
  touchedAt(area: Origin): number;
  /**
   * Starts drawing now, with the fire itself starting `fireIn` milliseconds later (the paper
   * over a `keepClear` area dissolves meanwhile).
   */
  start(fireIn?: number): void;
}

/** The easing of the front: how far along its travel it is at time fraction `p`. */
const eased = (p: number) => 1 - (1 - p) ** 2.4;
/** The inverse: the time fraction at which the front is `e` of the way along. */
const timeFor = (e: number) => (e <= 0 ? 0 : e >= 1 ? 1 : 1 - (1 - e) ** (1 / 2.4));

/** Distance from a point to a rectangle, in dots; zero inside it. */
function gapTo(x: number, y: number, rect: Origin): number {
  const dx = Math.max(rect.left / CELL - x, 0, x - rect.right / CELL);
  const dy = Math.max(rect.top / CELL - y, 0, y - rect.bottom / CELL);
  return Math.hypot(dx, dy);
}

const inside = (area: Origin, rect: Origin) =>
  area.left >= rect.left &&
  area.right <= rect.right &&
  area.top >= rect.top &&
  area.bottom <= rect.bottom;

/**
 * Burns `sheet` away from `origin`: a scorched, dithered band spreads outwards (or, with
 * `inward`, from the far edges in toward `origin`), darkest right beside the holes that open
 * behind it, until nothing of the sheet is left. Removes the sheet when done. The returned
 * `clearedAt` and `touchedAt` say when the fire will reach any area, so other motion can be
 * paced against it exactly.
 */
export function burn(sheet: HTMLElement, origin: Origin, options: BurnOptions = {}): Burn {
  const { toward, inward = false, keepClear, duration = DURATION_MS } = options;
  const width = Math.ceil(sheet.clientWidth / CELL);
  const height = Math.ceil(sheet.clientHeight / CELL);
  const mask = document.createElement("canvas");
  const char = document.createElement("canvas");
  for (const canvas of [mask, char]) {
    canvas.width = width;
    canvas.height = height;
  }
  const maskContext = mask.getContext("2d");
  const charContext = char.getContext("2d");
  if (!maskContext || !charContext || width === 0 || height === 0) {
    sheet.remove();
    return { clearedAt: () => 0, touchedAt: () => Number.POSITIVE_INFINITY, start: () => {} };
  }
  Object.assign(char.style, {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${width * CELL}px`,
    height: `${height * CELL}px`,
    imageRendering: "pixelated",
  });
  char.dataset.scorch = "";
  sheet.append(char);
  const holes = maskContext.createImageData(width, height);
  const scorched = charContext.createImageData(width, height);
  const [red, green, blue, alpha] = scorch();
  const ragged = raggedness(width, height, 16, RAGGED);
  // Leaning toward `toward`: distances in its direction count for less, so the front gets
  // there sooner. The lean grows with how far away it is, and fades off to the sides.
  const cx = (origin.left + origin.right) / 2 / CELL;
  const cy = (origin.top + origin.bottom) / 2 / CELL;
  const aim = toward ? { x: toward.x / CELL - cx, y: toward.y / CELL - cy } : { x: 0, y: 0 };
  const aimLength = Math.hypot(aim.x, aim.y) || 1;
  const lean = Math.min(1.8, Math.max(0, (aimLength * CELL - 180) / 420) * 1.8);
  const speedup = (x: number, y: number) => {
    if (!lean) return 1;
    const length = Math.hypot(x - cx, y - cy) || 1;
    const along = ((x - cx) * aim.x + (y - cy) * aim.y) / (length * aimLength);
    return 1 + lean * Math.max(0, along) ** 2;
  };
  const distance = new Float32Array(width * height);
  const clear = new Uint8Array(width * height);
  let far = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      distance[index] = gapTo(x, y, origin) / speedup(x, y) + (ragged[index] ?? 0);
      far = Math.max(far, distance[index] ?? 0);
      if (
        keepClear &&
        x * CELL + CELL > keepClear.left &&
        x * CELL < keepClear.right &&
        y * CELL + CELL > keepClear.top &&
        y * CELL < keepClear.bottom
      )
        clear[index] = 1;
    }
  }
  // Inward, the fire starts from the edges farthest from `origin` and closes in on it last.
  if (inward)
    for (let index = 0; index < distance.length; index++)
      distance[index] = far - (distance[index] ?? 0);
  const travel = far + HOLE_BAND * 1.6 + CHAR_BAND;
  /** When the front (see `frame`) reaches `position` along its travel. */
  const whenFront = (position: number) => timeFor((position + CHAR_BAND * 0.5) / travel) * duration;
  const corners = (area: Origin) =>
    [
      [area.left, area.top],
      [area.right, area.top],
      [area.left, area.bottom],
      [area.right, area.bottom],
    ].map(([x = 0, y = 0]) => gapTo(x / CELL, y / CELL, origin));
  const middle = (area: Origin) =>
    speedup((area.left + area.right) / 2 / CELL, (area.top + area.bottom) / 2 / CELL);

  const clearedAt = (area: Origin) => {
    // Where the area meets the fire first: its point nearest the origin.
    const near = gapTo(
      Math.max(area.left / CELL, Math.min(cx, area.right / CELL)),
      Math.max(area.top / CELL, Math.min(cy, area.bottom / CELL)),
      origin,
    );
    // Inward, that point is the last of the area to burn. Outward it is the first, and the
    // area counts as cleared once the fire has burned through there (with its ragged edge at
    // its latest): the measure the opening's flight pacing was tuned with.
    const last = inward ? far - near : near / middle(area) + RAGGED;
    return whenFront(last + HOLE_BAND);
  };
  const touchedAt = (area: Origin) => {
    if (keepClear && inside(area, keepClear)) return Number.POSITIVE_INFINITY;
    // The first cell of the area the scorch band reaches, with the ragged edge at its most
    // forward: farthest from the origin inward, nearest outward.
    const first = inward
      ? far - (Math.max(...corners(area)) + RAGGED)
      : Math.min(...corners(area), gapTo(cx, cy, area)) / middle(area);
    return whenFront(first - CHAR_BAND);
  };

  sheet.style.setProperty("mask-size", `${width * CELL}px ${height * CELL}px`);
  sheet.style.setProperty("mask-repeat", "no-repeat");
  let began = 0;
  let fireIn = 0;
  const run = currentTransition();
  const frame = (now: number) => {
    // A later transition has removed this sheet; stop drawing it.
    if (!stillRunning(run)) return;
    const progress = Math.min(1, Math.max(0, now - began - fireIn) / duration);
    const dissolve = (now - began) / KEEP_FADE_MS;
    // Starts a band behind the origin, so the first frame already shows scorching.
    const front = -CHAR_BAND * 0.5 + eased(progress) * travel;
    const hole = holes.data;
    const ink = scorched.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (clear[index]) {
          // Dissolves, dithered, from paper to clear; never scorched.
          hole[index * 4 + 3] = dissolve > bayer(x, y) ? 0 : 255;
          ink[index * 4 + 3] = 0;
          continue;
        }
        const behind = front - (distance[index] ?? 0);
        const threshold = bayer(x, y);
        // Holes open across the band behind the front, with ripple rings running through it.
        const open = behind / HOLE_BAND + 0.04 * Math.sin(behind * 0.5);
        hole[index * 4 + 3] = open > threshold + 0.03 ? 0 : 255;
        // Scorch builds up ahead of the holes and is complete where they begin.
        const heat = Math.min(1, (behind + CHAR_BAND) / CHAR_BAND);
        const on = heat > 0 && heat * 0.5 > bayer(x + 1, y + 2);
        ink[index * 4] = red;
        ink[index * 4 + 1] = green;
        ink[index * 4 + 2] = blue;
        ink[index * 4 + 3] = on ? alpha : 0;
      }
    }
    charContext.putImageData(scorched, 0, 0);
    maskContext.putImageData(holes, 0, 0);
    sheet.style.setProperty("mask-image", `url(${mask.toDataURL()})`);
    if (progress < 1) requestAnimationFrame(frame);
    else sheet.remove();
  };
  const start = (delay = 0) => {
    if (began) return;
    fireIn = delay;
    began = performance.now();
    frame(began);
  };
  if (!options.hold) start();
  return { clearedAt, touchedAt, start };
}
