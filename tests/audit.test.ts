import { describe, expect, test } from "bun:test";
import { auditHardTask } from "../src/audit.js";
import type { TaskDefinition } from "../src/contracts.js";

const definition: TaskDefinition = {
  schemaVersion: 1,
  difficulty: "hard",
  taskId: "example",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  workdir: ".",
  setupCommand: "true",
  testCommand: "test {tests}",
  failToPass: ["tests/new"],
  passToPass: ["tests/a", "tests/b"],
  testPaths: ["tests/new"],
  toolchains: ["node"],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement behavior.",
  timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
  resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
};

describe("hard-mode audit", () => {
  test("accepts three implementation files and at least one hundred changed lines", () => {
    const gold = ["src/a.ts", "src/b.ts", "src/c.ts"]
      .map(
        (path, index) =>
          `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${Array.from({ length: index === 0 ? 98 : 1 }, (_, line) => `+line-${index}-${line}`).join("\n")}`,
      )
      .join("\n");
    const tests =
      "diff --git a/tests/new.ts b/tests/new.ts\n--- a/tests/new.ts\n+++ b/tests/new.ts\n+test";

    expect(auditHardTask(definition, gold, tests).accepted).toBe(true);
  });

  test("rejects easy-sized and overlapping patches", () => {
    const patch =
      "diff --git a/tests/new.ts b/tests/new.ts\n--- a/tests/new.ts\n+++ b/tests/new.ts\n+line";
    const audit = auditHardTask(definition, patch, patch);

    expect(audit.accepted).toBe(false);
    expect(audit.blockers.join(" ")).toContain("at least 3 implementation files");
    expect(audit.blockers.join(" ")).toContain("overlap");
  });
});
