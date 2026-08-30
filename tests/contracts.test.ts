import { describe, expect, test } from "bun:test";
import { runRequestSchema, taskDefinitionSchema } from "../src/contracts.js";

const definition = {
  schemaVersion: 2 as const,
  difficulty: "easy",
  taskId: "tiered-task",
  repo: "https://github.com/example/repo.git",
  baseCommit: "a".repeat(40),
  workdir: ".",
  testCommand: "bun test {tests}",
  failToPass: ["new behavior"],
  passToPass: ["existing behavior"],
  testPaths: ["tests/held-out.test.ts"],
  environment: {
    schemaVersion: 1 as const,
    baseImage: `node:22@sha256:${"d".repeat(64)}`,
    rootSetupCommand: "apt-get update && apt-get install -y bash git passwd procps tar",
    setupCommand: "bun install --frozen-lockfile",
    smokeCommand: "bun --version",
    environmentVariables: {},
    services: [],
    source: "ci-adapted" as const,
    evidence: [{ path: "package.json", reason: "Pins Bun and the test script." }],
  },
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
    schema: 2,
  },
};

describe("contracts", () => {
  test("accepts all three task difficulties", () => {
    for (const difficulty of ["easy", "medium", "hard"]) {
      expect(taskDefinitionSchema.safeParse({ ...definition, difficulty }).success).toBe(true);
    }
  });

  test("binds task definitions to one canonical repository and pull request", () => {
    expect(
      taskDefinitionSchema.safeParse({
        ...definition,
        repo: "example/other",
      }).success,
    ).toBe(false);
    expect(
      taskDefinitionSchema.safeParse({
        ...definition,
        testCommand: "bun test {tests} && bun test {tests}",
      }).success,
    ).toBe(false);
    expect(
      taskDefinitionSchema.safeParse({
        ...definition,
        testPaths: ["../outside.test.ts"],
      }).success,
    ).toBe(false);
  });

  test("requires between one and ten thousand candidates across tiers", () => {
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 0, medium: 0, hard: 0 },
      }).success,
    ).toBe(false);
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 3_334, medium: 3_333, hard: 3_333 },
      }).success,
    ).toBe(true);
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 3_334, medium: 3_334, hard: 3_333 },
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
            sandboxTimeoutCapMs: 45 * 60 * 1_000,
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

  test("persists E2B generation separately from its Docker or Modal Harbor backend", () => {
    for (const harborEnvironment of ["docker", "modal"]) {
      const parsed = runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        version: {
          ...request.version,
          executionBackend: "e2b",
          harborEnvironment,
          sandboxImage: "selfbench-runtime:v1",
          sandboxTimeoutCapMs: 60 * 60 * 1_000,
        },
      });
      expect(parsed.success).toBe(true);
    }
  });

  test("requires an explicit Harbor backend for E2B requests", () => {
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        version: {
          ...request.version,
          executionBackend: "e2b",
          harborEnvironment: undefined,
          sandboxImage: "selfbench-runtime:v1",
        },
      }).success,
    ).toBe(false);
  });

  test("rejects hosted-only timeout metadata on Docker and Modal", () => {
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        version: { ...request.version, sandboxTimeoutCapMs: 45 * 60 * 1_000 },
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

  test("rejects legacy requests without an explicit Harbor backend", () => {
    for (const executionBackend of ["docker", "modal", "vercel"] as const) {
      expect(
        runRequestSchema.safeParse({
          ...request,
          candidateCounts: { easy: 1, medium: 0, hard: 0 },
          version: {
            ...request.version,
            executionBackend,
            harborEnvironment: undefined,
          },
        }).success,
      ).toBe(false);
    }
  });

  test("rejects schema-1 run metadata", () => {
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 1, medium: 0, hard: 0 },
        version: { ...request.version, schema: 1 },
      }).success,
    ).toBe(false);
  });
});
