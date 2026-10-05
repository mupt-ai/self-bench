import { expect, test } from "bun:test";
import { accuracyInterval, wilson95 } from "../src/public/accuracy-interval.js";

test("Wilson intervals match known 95% binomial intervals", () => {
  expect(wilson95(5, 10).lower).toBeCloseTo(23.7, 1);
  expect(wilson95(5, 10).upper).toBeCloseTo(76.3, 1);
  expect(wilson95(1, 1).lower).toBeCloseTo(20.7, 1);
  expect(wilson95(0, 1).upper).toBeCloseTo(79.3, 1);
});

test("a perfect or zero score is exactly its own bound, whatever the task count", () => {
  // 10 of 10 once gave 99.99999999999999, leaving a 100% score outside its interval, which the
  // chart rejects.
  for (const tasks of [1, 3, 7, 10, 36, 40, 97]) {
    expect(wilson95(tasks, tasks).upper).toBe(100);
    expect(wilson95(0, tasks).lower).toBe(0);
  }
});

test("Wilson intervals validate successes and trial counts", () => {
  for (const [passed, tasks] of [
    [-1, 1],
    [2, 1],
    [1, 0],
    [1.5, 2],
    [1, 2.5],
  ]) {
    expect(() => wilson95(passed ?? 0, tasks ?? 0)).toThrow(RangeError);
  }
});

test("a chart gets an interval only when the counts agree with the accuracy it plots", () => {
  expect(accuracyInterval({ passed: 10, tasks: 10, accuracy: 100 })).toEqual([
    wilson95(10, 10).lower,
    100,
  ]);
  // Counts that cannot be used, or that disagree with the plotted accuracy: no bar, no error.
  expect(accuracyInterval({ passed: 5, tasks: 10, accuracy: 94 })).toBeUndefined();
  expect(accuracyInterval({ passed: 0, tasks: 0, accuracy: 0 })).toBeUndefined();
  expect(accuracyInterval({ passed: 11, tasks: 10, accuracy: 100 })).toBeUndefined();
});
