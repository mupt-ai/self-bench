import { describe, expect, test } from "bun:test";
import { runRequestSchema, taskDefinitionSchema } from "../src/contracts.js";

const definition = {
  schemaVersion: 1 as const,
  difficulty: "easy",
  taskId: "tiered-task",
  repo: "https://github.com/example/repo.git",
  baseCommit: "a".repeat(40),
  workdir: "/app",
  setupCommand: "bun install --frozen-lockfile",
  testCommand: "bun test {tests}",
  failToPass: ["new behavior"],
  passToPass: ["existing behavior"],
  testPaths: ["tests/held-out.test.ts"],
  toolchains: ["bun" as const],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement the requested behavior.",
  timeouts: { setupSeconds: 900, agentSeconds: 2400, testsSeconds: 900 },
  resources: { cpus: 4, memoryMb: 8192, storageMb: 20480 },
};

const request = {
  runId: "run-tiered-candidates",
  repository: { url: "https://github.com/example/repo.git", commit: "a".repeat(40) },
  provenance: {
    uri: "file:///provenance.jsonl",
    sha256: "c".repeat(64),
    sizeBytes: 1,
    contentType: "application/x-ndjson",
  },
  authoring: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
  version: {
    selfbenchCommit: "b".repeat(40),
    executionBackend: "docker",
    sandboxImage: "selfbench-sandbox:local",
    schema: 1,
  },
};

describe("contracts", () => {
  test("accepts all three task difficulties", () => {
    for (const difficulty of ["easy", "medium", "hard"]) {
      expect(taskDefinitionSchema.safeParse({ ...definition, difficulty }).success).toBe(true);
    }
  });

  test("requires between one and one hundred candidates across tiers", () => {
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 0, medium: 0, hard: 0 },
      }).success,
    ).toBe(false);
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 34, medium: 33, hard: 33 },
      }).success,
    ).toBe(true);
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 34, medium: 34, hard: 33 },
      }).success,
    ).toBe(false);
  });
});
