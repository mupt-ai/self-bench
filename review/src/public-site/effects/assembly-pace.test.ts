import { expect, test } from "bun:test";
import { advanceFrontier, FAR_BOOST, frontierSpeed } from "./assembly-pace";

// A laptop view: 790px tall, the title block above a start line at 190px.
const shape = { base: 790 / 540, fold: 790, view: 790 };

test("the visible part runs at an even pace until near the bottom of the view", () => {
  for (const y of [190, 300, 450, 590]) expect(frontierSpeed(y, shape)).toBeCloseTo(shape.base, 6);
  // It eases up before the fold, so the speed-up past it does not start from a standstill.
  const atFold = frontierSpeed(shape.fold, shape) / shape.base;
  expect(atFold).toBeGreaterThan(1.3);
  expect(atFold).toBeLessThan(3);
});

test("below the view it reaches the full boost and stays there", () => {
  const far = shape.fold + shape.view;
  expect(frontierSpeed(far, shape)).toBeCloseTo(shape.base * FAR_BOOST, 6);
  expect(frontierSpeed(far * 4, shape)).toBeCloseTo(shape.base * FAR_BOOST, 6);
});

test("the speed never drops and never jumps: a smooth bend between the two paces", () => {
  let previous = frontierSpeed(0, shape);
  let steepest = 0;
  for (let y = 1; y < 4000; y++) {
    const speed = frontierSpeed(y, shape);
    expect(speed).toBeGreaterThanOrEqual(previous - 1e-12);
    steepest = Math.max(steepest, speed - previous);
    previous = speed;
  }
  // Per pixel of travel the speed changes by well under a percent of the base pace...
  expect(steepest / shape.base).toBeLessThan(0.02);
  // ...and the change itself fades in and out (smoothstep): tiny at both ends of the bend.
  const slope = (y: number) => frontierSpeed(y + 1, shape) - frontierSpeed(y, shape);
  const from = shape.fold - 0.25 * shape.view;
  expect(slope(from + 1)).toBeLessThan(slope(shape.fold) / 50);
});

test("a first screen takes as long as before; a long page finishes soon after", () => {
  const timeTo = (target: number, start = 190) => {
    let y = start;
    let ms = 0;
    while (y < target) {
      y = advanceFrontier(y, 16, shape);
      ms += 16;
    }
    return ms;
  };
  // The old linear frontier crossed the visible part (190px to the fold) in about 410ms.
  const visible = timeTo(shape.fold);
  expect(visible).toBeGreaterThan(330);
  expect(visible).toBeLessThan(430);
  // A page four screens long: linear would take about 2.1s; now it is well under a second.
  expect(timeTo(4 * shape.view)).toBeLessThan(900);
});

test("advancing in one big step or many small ones ends up in the same place", () => {
  const once = advanceFrontier(500, 48, shape);
  let many = 500;
  for (let step = 0; step < 12; step++) many = advanceFrontier(many, 4, shape);
  expect(once).toBeCloseTo(many, 6);
});
