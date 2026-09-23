/**
 * The geometry and timing of a card part's flight to its spot on the new page, worked out
 * ahead of time so the flight can be paced against the fire burning the old page away.
 */

/** Leaves at once and eases into the landing, so the move reads as starting on the click. */
export const FLIGHT_EASING = "cubic-bezier(0.2, 0.65, 0.2, 1)";
const CURVE = [0.2, 0.65, 0.2, 1] as const;
/** The longest hold before takeoff that still reads as one motion; beyond it, fly slower. */
const MAX_HOLD_MS = 90;
const SAMPLES = 48;

/** CSS cubic-bezier timing: eased progress at time fraction `x`. */
function eased(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = CURVE;
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  // Bisect for the curve parameter whose x is `x`, then read its y.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2;
    if (at(x1, x2, middle) < x) low = middle;
    else high = middle;
  }
  return at(y1, y2, (low + high) / 2);
}

/** A rectangle in viewport coordinates. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FlightPath {
  /** The landing spot, in viewport coordinates. */
  to: Box;
  dx: number;
  dy: number;
  lift: number;
  scale: number;
}

/** From a card part (its box and text size) to its landing spot. */
export function flightPath(
  start: { rect: DOMRect; fontSize: number },
  target: HTMLElement,
  byBox: boolean,
): FlightPath {
  const to = target.getBoundingClientRect();
  const targetFont = Number.parseFloat(getComputedStyle(target).fontSize) || 1;
  const dy = start.rect.top - to.top;
  return {
    to,
    dx: start.rect.left - to.left,
    dy,
    lift: Math.min(24, Math.abs(dy) * 0.12),
    // A logo scales by its size; text by its font size, so letters keep their shape.
    scale: byBox ? start.rect.height / (to.height || 1) : start.fontSize / targetFont,
  };
}

/** The flight as keyframes: from the card, arcing up a little, onto the landing spot. */
export function flightKeyframes(path: FlightPath, fadeIn: boolean): Keyframe[] {
  const { dx, dy, lift, scale } = path;
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: fadeIn ? 0 : 1 },
    {
      transform: `translate(${dx * 0.4}px, ${dy * 0.4 - lift}px) scale(${scale + (1 - scale) * 0.55})`,
      opacity: 1,
      offset: 0.5,
    },
    { transform: "none", opacity: 1 },
  ];
}

/** Where the flying part is, in viewport coordinates, a fraction `u` of the way through. */
export function boxAtTime(path: FlightPath, u: number): Box {
  return boxAt(path, eased(u));
}

/** Where the flying part is, in viewport coordinates, at eased progress `p`. */
function boxAt(path: FlightPath, p: number): Box {
  const { to, dx, dy, lift, scale } = path;
  const middle = { x: dx * 0.4, y: dy * 0.4 - lift, s: scale + (1 - scale) * 0.55 };
  const [a, b, t] =
    p < 0.5
      ? [{ x: dx, y: dy, s: scale }, middle, p / 0.5]
      : [middle, { x: 0, y: 0, s: 1 }, (p - 0.5) / 0.5];
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const s = a.s + (b.s - a.s) * t;
  return { left: to.left + x, top: to.top + y, width: to.width * s, height: to.height * s };
}

/**
 * How far into the flight (as a fraction of its time) every part has come to rest: within
 * `within` pixels of its landing spot in both position and size. With the flight's long
 * ease-out, this is well before the animation formally ends; after it nothing visibly moves.
 */
export function settleTime(paths: FlightPath[], within = 1): number {
  const steps = 400;
  for (let step = 0; step <= steps; step++) {
    const u = step / steps;
    const resting = paths.every((path) => {
      const box = boxAtTime(path, u);
      return (["left", "top", "width", "height"] as const).every(
        (key) => Math.abs(box[key] - path.to[key]) <= within,
      );
    });
    if (resting) return u;
  }
  return 1;
}

/**
 * Paces the flights so no part ever flies over paper that has not burned yet. `clearedIn`
 * says how many milliseconds from now the fire will have burned through a box. Every point of
 * every path is checked against it; the flight waits briefly on the card if that is enough,
 * and otherwise flies more slowly, so it stays one continuous motion.
 */
export function paceFlight(
  paths: FlightPath[],
  clearedIn: (box: Box) => number,
  baseMs: number,
): { duration: number; delay: number } {
  const samples = Array.from({ length: SAMPLES + 1 }, (_, index) => index / SAMPLES);
  const needs = paths.flatMap((path) =>
    samples.map((u) => ({ u, clears: clearedIn(boxAtTime(path, u)) })),
  );
  let plan = { duration: baseMs, delay: 0 };
  for (const stretch of [1, 1.2, 1.4, 1.65, 1.9, 2.2]) {
    const duration = baseMs * stretch;
    const delay = Math.max(0, ...needs.map(({ u, clears }) => clears - u * duration));
    plan = { duration, delay };
    if (delay <= MAX_HOLD_MS) break;
  }
  return plan;
}

/**
 * For a flight that must stay ahead of a fire (the return, where the fire chases the title
 * into its card): how long after the flight is scheduled the fire has to start, at the
 * earliest, so it never touches any point of any path before the part has passed it.
 * `touchedIn` says when, after the fire's own start, it first touches a box.
 */
export function fireStartAfter(
  paths: FlightPath[],
  touchedIn: (box: Box) => number,
  pace: { duration: number; delay: number },
): number {
  let latest = 0;
  for (const path of paths)
    for (let index = 0; index <= SAMPLES; index++) {
      const u = index / SAMPLES;
      latest = Math.max(latest, pace.delay + u * pace.duration - touchedIn(boxAtTime(path, u)));
    }
  return latest;
}
