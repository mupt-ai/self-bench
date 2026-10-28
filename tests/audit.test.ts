import { describe, expect, test } from "bun:test";
import { auditPatches } from "../src/generation/task/audit.js";

function patch(files: number, lines: number): string {
  return Array.from({ length: files }, (_, index) => {
    const changedLines = index === 0 ? lines - files + 1 : 1;
    const path = `src/${index}.ts`;
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${Array.from({ length: changedLines }, (_, line) => `+line-${index}-${line}`).join("\n")}`;
  }).join("\n");
}

const tests =
  "diff --git a/tests/new.ts b/tests/new.ts\n--- a/tests/new.ts\n+++ b/tests/new.ts\n+test";

describe("tiered task audit", () => {
  test.each([
    ["easy", 1, 20],
    ["medium", 2, 50],
    ["hard", 3, 100],
  ] as const)("accepts %s at its threshold", (difficulty, files, lines) => {
    expect(auditPatches(patch(files, lines), tests, difficulty)).toEqual({
      difficulty,
      blockers: [],
    });
  });

  test("takes the hardest tier the gold reaches, never above the assigned one", () => {
    expect(auditPatches(patch(2, 99), tests, "hard").difficulty).toBe("medium");
    expect(auditPatches(patch(3, 100), tests, "medium").difficulty).toBe("medium");
  });

  test("blocks a gold patch below easy", () => {
    expect(auditPatches(patch(1, 19), tests, "hard").blockers).toEqual([
      "gold.patch changes 19 lines across 1 files; even easy needs at least 20 across 1",
    ]);
  });

  test("blocks patches that change the same file, including a renamed one", () => {
    const rename =
      "diff --git a/tests/new.ts b/src/moved.ts\nsimilarity index 100%\nrename from tests/new.ts\nrename to src/moved.ts\n";
    expect(auditPatches(`${patch(3, 100)}\n${rename}`, tests, "hard").blockers).toEqual([
      "gold.patch and test.patch both change tests/new.ts",
    ]);
  });
});
