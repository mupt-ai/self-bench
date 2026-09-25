import { expect, test } from "bun:test";
import type { ReleasePreview } from "./api";
import { selectionOf } from "./selection";

const setting = (key: string, coverage: number[]) =>
  ({
    key,
    id: key,
    catalogId: key,
    modelName: key,
    label: key,
    harness: "codex",
    reasoningLevel: "high",
    provider: "openai",
    signIn: "api-key",
    custom: false,
    coverage,
    ticked: false,
  }) as const;

// t0 and t1 were in the current release, t2 is new, t3 is returning; t9 was removed.
const preview: ReleasePreview = {
  fingerprint: "f".repeat(64),
  tasks: [
    { key: "t0", runId: "gen", taskId: "t0", difficulty: "easy", status: "released" },
    { key: "t1", runId: "gen", taskId: "t1", difficulty: "easy", status: "released" },
    { key: "t2", runId: "gen", taskId: "t2", difficulty: "easy", status: "new" },
    { key: "t3", runId: "gen", taskId: "t3", difficulty: "easy", status: "returning" },
  ],
  removed: [{ key: "t9", runId: "gen", taskId: "t9", state: "rejected" }],
  unrun: 0,
  settings: [setting("a", [0, 1, 2, 3]), setting("b", [0, 1, 2]), setting("c", [0, 1])],
};

test("the task set is every task all ticked settings ran", () => {
  expect(selectionOf(preview, new Set(["a"])).tasks).toEqual([0, 1, 2, 3]);
  expect(selectionOf(preview, new Set(["a", "b"])).tasks).toEqual([0, 1, 2]);
  expect(selectionOf(preview, new Set(["a", "b", "c"])).tasks).toEqual([0, 1]);
  expect(selectionOf(preview, new Set()).tasks).toEqual([]);
});

test("added tasks are labelled new or returning; removed ones count as left out", () => {
  const selection = selectionOf(preview, new Set(["a"]));
  expect(selection.added).toEqual({ new: 1, returning: 1 });
  expect(selection.droppedFromCurrent).toBe(1);
});
