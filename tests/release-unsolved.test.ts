import { expect, test } from "bun:test";
import { previewRelease } from "../src/public/release-build.js";
import { unsolvedTasks } from "../src/public/release-rule.js";
import { approvedTasks, inputs, names, run } from "./support/release-fixture.js";

/** Tasks every setting failed are flagged for a person to check their tests; nothing else changes. */

test("a task three or more settings ran and none passed is unsolved", () => {
  const failing = (count: number) => Array.from({ length: count }, () => [["t1", false] as const]);
  expect(unsolvedTasks(failing(2)).size).toBe(0);
  expect([...unsolvedTasks(failing(3))]).toEqual([["t1", 3]]);
  expect(unsolvedTasks([...failing(3), [["t1", true] as const]]).size).toBe(0);
});

test("the preview flags unsolved tasks without changing coverage or ticks", () => {
  const runs = [
    run({ model: "s1", results: { t1: 1, t2: 0, t3: 0 } }),
    run({ model: "s2", results: { t1: 1, t2: 0, t3: 0 } }),
    run({ model: "s3", results: { t1: 0, t2: 0 } }),
  ];
  const preview = previewRelease(inputs({ runs, tasks: approvedTasks(names(1, 3)) }));
  // t1 was passed and t3 has only two results.
  expect(preview.tasks.map((task) => task.unsolved)).toEqual([undefined, 3, undefined]);
  expect(preview.settings.map((setting) => setting.coverage)).toEqual([
    [0, 1, 2],
    [0, 1, 2],
    [0, 1],
  ]);
});
