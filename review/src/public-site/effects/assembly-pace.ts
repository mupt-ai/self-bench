/**
 * How fast the assembly frontier moves down the page. Across the first screenful it runs at
 * an even pace, easing up a little as it nears the bottom of the view; past the view, where
 * nobody is watching yet, it keeps accelerating to many times that pace, so a long page is
 * whole soon after the visible part is. The bend between the two is smooth (a smoothstep in
 * position), so the frontier never lurches.
 */

/** How many times the base pace the frontier reaches well below the view. */
export const FAR_BOOST = 10;
/** Where the speed-up begins, as a share of the view's height above its bottom edge. */
const EASE_FROM = 0.25;
/** How far below the view's bottom edge, in view heights, the full boost is reached. */
const EASE_TO = 0.75;

export interface PaceShape {
  /** Frontier speed across the visible part, in pixels per millisecond. */
  base: number;
  /** The bottom of the view when the assembly starts, in the page's own coordinates. */
  fold: number;
  /** The view's height. */
  view: number;
}

const smoothstep = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Frontier speed, in pixels per millisecond, with the frontier at page position `y`. */
export function frontierSpeed(y: number, { base, fold, view }: PaceShape): number {
  const from = fold - EASE_FROM * view;
  const to = fold + EASE_TO * view;
  return base * (1 + (FAR_BOOST - 1) * smoothstep((y - from) / (to - from)));
}

/** Moves the frontier forward over `ms` milliseconds, in small steps for a smooth curve. */
export function advanceFrontier(y: number, ms: number, shape: PaceShape): number {
  let at = y;
  const steps = Math.max(1, Math.ceil(ms / 4));
  for (let step = 0; step < steps; step++) at += frontierSpeed(at, shape) * (ms / steps);
  return at;
}
