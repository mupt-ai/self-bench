import { expect, test } from "bun:test";
import {
  type Box,
  boxAtTime,
  type FlightPath,
  fireStartAfter,
  flightKeyframes,
  paceFlight,
  settleTime,
} from "./flight-path";

/** A flight from a card low on the page up to a landing spot near the top. */
const path: FlightPath = {
  to: { left: 400, top: 100, width: 200, height: 32 },
  dx: 500,
  dy: 600,
  lift: 24,
  scale: 0.6,
};
const BASE = 600;

/** A fire starting at the card (y = 700) and spreading upwards at `speed` px per ms. */
const fire = (speed: number) => (box: Box) => Math.max(0, (700 - box.top) / speed);

/** The guarantee: at every moment of the flight, the part is over paper already burned. */
function neverAhead(clearedIn: (box: Box) => number, pace: { duration: number; delay: number }) {
  for (let step = 0; step <= 200; step++) {
    const u = step / 200;
    expect(clearedIn(boxAtTime(path, u))).toBeLessThanOrEqual(pace.delay + u * pace.duration + 1);
  }
}

test("a flight over already-burned paper keeps its normal pace", () => {
  expect(paceFlight([path], () => 0, BASE)).toEqual({ duration: BASE, delay: 0 });
});

test("the flight starts and ends exactly where it should", () => {
  expect(boxAtTime(path, 0)).toMatchObject({ left: 900, top: 700 });
  const landed = boxAtTime(path, 1);
  for (const key of ["left", "top", "width", "height"] as const)
    expect(landed[key]).toBeCloseTo(path.to[key], 3);
  const frames = flightKeyframes(path, true);
  expect(frames[0]?.opacity).toBe(0);
  expect(frames.at(-1)).toEqual({ transform: "none", opacity: 1 });
});

test("a fast fire needs little or no waiting", () => {
  const clearedIn = fire(3);
  const pace = paceFlight([path], clearedIn, BASE);
  expect(pace.duration).toBe(BASE);
  neverAhead(clearedIn, pace);
});

test("a slow fire slows the flight instead of holding it on the card for long", () => {
  const clearedIn = fire(0.8);
  const pace = paceFlight([path], clearedIn, BASE);
  expect(pace.duration).toBeGreaterThan(BASE);
  neverAhead(clearedIn, pace);
});

test("however slow the fire, the flight never gets ahead of it", () => {
  const clearedIn = fire(0.1);
  neverAhead(clearedIn, paceFlight([path], clearedIn, BASE));
});

test("the flight comes to rest before it formally ends, and stays at rest", () => {
  const rest = settleTime([path]);
  expect(rest).toBeGreaterThan(0.5);
  expect(rest).toBeLessThan(1);
  for (const u of [rest, (rest + 1) / 2, 1]) {
    const box = boxAtTime(path, u);
    expect(Math.abs(box.top - path.to.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.left - path.to.left)).toBeLessThanOrEqual(1);
  }
  // Just before resting it is still visibly moving.
  const before = boxAtTime(path, rest - 0.05);
  expect(Math.abs(before.top - path.to.top) + Math.abs(before.left - path.to.left)).toBeGreaterThan(
    1,
  );
});

/**
 * The return, where the fire closes in on the card (bottom right) from the far edges and the
 * title must stay ahead of it: the farther a box is from the card, the sooner it is touched.
 */
const closingIn = (speed: number) => (box: Box) => {
  const fromCard = Math.hypot(900 - box.left, 700 - box.top);
  return Math.max(0, (1100 - fromCard) / speed);
};
const returning: FlightPath = {
  to: { left: 900, top: 700, width: 120, height: 20 },
  dx: -500,
  dy: -600,
  lift: 24,
  scale: 1.7,
};

test("the fire starts late enough never to touch the title before it has passed", () => {
  for (const speed of [0.5, 1.5, 4]) {
    const touchedIn = closingIn(speed);
    const pace = { duration: 480, delay: 90 };
    const fireStart = fireStartAfter([returning], touchedIn, pace);
    for (let step = 0; step <= 200; step++) {
      const u = step / 200;
      const titleThere = pace.delay + u * pace.duration;
      expect(fireStart + touchedIn(boxAtTime(returning, u))).toBeGreaterThanOrEqual(titleThere);
    }
  }
});

test("a fire that could not catch the title starts at once", () => {
  expect(fireStartAfter([returning], () => 10_000, { duration: 480, delay: 90 })).toBe(0);
});
