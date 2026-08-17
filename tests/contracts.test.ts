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
    harborEnvironment: "docker",
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

  test("persists Vercel generation separately from its Docker or Modal Harbor backend", () => {
    for (const harborEnvironment of ["docker", "modal"]) {
      expect(
        runRequestSchema.safeParse({
          ...request,
          candidateCounts: { easy: 1, medium: 0, hard: 0 },
          version: {
            ...request.version,
            executionBackend: "vercel",
            harborEnvironment,
            sandboxImage: `iad1.vcr.dev/dari/selfbench/runtime@sha256:${"a".repeat(64)}`,
          },
        }).success,
      ).toBe(true);
    }
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        version: {
          ...request.version,
          executionBackend: "vercel",
          harborEnvironment: "vercel",
        },
      }).success,
    ).toBe(false);
  });

  test("persists cross-provider Docker and Modal generation/Harbor pairs", () => {
    for (const [executionBackend, harborEnvironment] of [
      ["docker", "modal"],
      ["modal", "docker"],
    ] as const) {
      expect(
        runRequestSchema.parse({
          ...request,
          candidateCounts: { easy: 1, medium: 0, hard: 0 },
          version: {
            ...request.version,
            executionBackend,
            harborEnvironment,
          },
        }).version,
      ).toMatchObject({ executionBackend, harborEnvironment });
    }
  });

  test("normalizes legacy schema-1 Docker and Modal requests to their matching Harbor backend", () => {
    for (const executionBackend of ["docker", "modal"] as const) {
      const parsed = runRequestSchema.parse({
        ...request,
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        version: {
          ...request.version,
          executionBackend,
          harborEnvironment: undefined,
        },
      });

      expect(parsed.version.harborEnvironment).toBe(executionBackend);
    }
  });

  test("does not infer a Harbor backend for Vercel schema-1 requests", () => {
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        version: {
          ...request.version,
          executionBackend: "vercel",
          harborEnvironment: undefined,
        },
      }).success,
    ).toBe(false);
  });
});
