import { describe, expect, test } from "bun:test";
import { runRequestSchema, taskDefinitionSchema } from "../src/contracts.js";

describe("contracts", () => {
  test("hard is the only task difficulty", () => {
    const result = taskDefinitionSchema.safeParse({
      schemaVersion: 1,
      difficulty: "easy",
      taskId: "hard-task",
      repo: "https://github.com/example/repo.git",
      baseCommit: "a".repeat(40),
      workdir: "/app",
      setupCommand: "bun install --frozen-lockfile",
      testCommand: "bun test {tests}",
      failToPass: ["new behavior"],
      passToPass: ["existing behavior"],
      testPaths: ["tests/held-out.test.ts"],
      toolchains: ["bun"],
      sourcePr: 1,
      sourceUrl: "https://github.com/example/repo/pull/1",
      prompt: "Implement the requested behavior.",
      timeouts: { setupSeconds: 900, agentSeconds: 2400, testsSeconds: 900 },
      resources: { cpus: 4, memoryMb: 8192, storageMb: 20480 },
    });
    expect(result.success).toBe(false);
  });

  test("preserves an explicit zero reserve count", () => {
    const result = runRequestSchema.parse({
      runId: "run-zero-reserves",
      repository: { url: "https://github.com/example/repo.git", commit: "a".repeat(40) },
      provenance: {
        uri: "file:///provenance.jsonl",
        sha256: "c".repeat(64),
        sizeBytes: 1,
        contentType: "application/x-ndjson",
      },
      count: 1,
      reserveCount: 0,
      authoring: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      version: {
        selfbenchCommit: "b".repeat(40),
        executionBackend: "docker",
        sandboxImage: "selfbench-sandbox:local",
        schema: 1,
      },
    });

    expect(result.reserveCount).toBe(0);
  });
});
