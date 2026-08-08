import { describe, expect, test } from "bun:test";
import { auditTaskDefinition } from "../src/audit.js";
import type { Difficulty, TaskDefinition } from "../src/contracts.js";

const definition: TaskDefinition = {
  schemaVersion: 1,
  difficulty: "hard",
  taskId: "task",
  repo: "https://github.com/example/repo.git",
  baseCommit: "a".repeat(40),
  workdir: ".",
  setupCommand: "bun install",
  testCommand: "bun test {tests}",
  failToPass: ["tests/new.ts"],
  passToPass: ["tests/a.ts", "tests/b.ts"],
  testPaths: ["tests/new.ts"],
  toolchains: ["bun"],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement behavior",
  timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
  resources: { cpus: 1, memoryMb: 1, storageMb: 1 },
};

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
    ["easy", 1, 20, 0],
    ["medium", 2, 50, 1],
    ["hard", 3, 100, 2],
  ] as const)("accepts %s at its threshold", (difficulty, files, lines, passToPass) => {
    const result = auditTaskDefinition(
      {
        ...definition,
        difficulty,
        passToPass: Array.from({ length: passToPass }, (_, index) => `tests/p${index}.ts`),
      },
      patch(files, lines),
      tests,
    );
    expect(result.accepted).toBe(true);
  });

  test.each([
    ["easy", 19],
    ["medium", 49],
    ["hard", 99],
  ] as const)("rejects %s below its line threshold", (difficulty, lines) => {
    const files: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 3 };
    const result = auditTaskDefinition(
      { ...definition, difficulty },
      patch(files[difficulty], lines),
      tests,
    );
    expect(result.accepted).toBe(false);
    expect(result.blockers.join("; ")).toContain(`${difficulty} mode requires at least`);
  });

  test("rejects a test command that hard-codes selected paths outside the placeholder", () => {
    const result = auditTaskDefinition(
      { ...definition, testCommand: "test {tests} && test tests/new.ts" },
      patch(3, 100),
      tests,
    );
    expect(result.accepted).toBe(false);
    expect(result.blockers).toContain(
      'test command must not hard-code fail-to-pass or pass-to-pass paths outside "{tests}"',
    );
  });

  test("rejects overlapping patches", () => {
    const overlapping = patch(3, 100);
    expect(auditTaskDefinition(definition, overlapping, overlapping).accepted).toBe(false);
  });
});
