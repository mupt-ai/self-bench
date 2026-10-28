import { describe, expect, test } from "bun:test";
import {
  reviewRoundResultSchema,
  runRequestSchema,
  taskImagesSchema,
} from "../src/contracts/index.js";

const request = {
  runId: "run-tiered-candidates",
  repository: { url: "https://github.com/example/repo.git", commit: "a".repeat(40) },
  provenance: {
    uri: "file:///provenance.jsonl",
    sha256: "c".repeat(64),
    sizeBytes: 1,
    contentType: "application/x-ndjson",
  },
  authoring: { provider: "openai-codex", model: "gpt-6-sol", reasoningEffort: "high" },
  version: {
    selfbenchCommit: "b".repeat(40),
    executionBackend: "docker",
    harborEnvironment: "docker",
    sandboxImage: "selfbench-sandbox:local",
    schema: 2,
  },
};

describe("contracts", () => {
  test("requires between one and three hundred candidates across tiers", () => {
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 0, medium: 0, hard: 0 },
      }).success,
    ).toBe(false);
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 100, medium: 100, hard: 100 },
      }).success,
    ).toBe(true);
    expect(
      runRequestSchema.safeParse({
        ...request,
        candidateCounts: { easy: 100, medium: 100, hard: 101 },
      }).success,
    ).toBe(false);
  });

  test("persists Vercel generation separately from any Harbor backend", () => {
    for (const harborEnvironment of ["docker", "modal", "vercel", "e2b", "daytona"]) {
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
          harborEnvironment: "runloop",
        },
      }).success,
    ).toBe(false);
  });

  test("persists E2B generation separately from any Harbor backend", () => {
    for (const harborEnvironment of ["docker", "modal", "vercel", "e2b", "daytona"]) {
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
      ["modal", "daytona"],
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
    for (const executionBackend of ["docker", "modal", "vercel", "e2b"] as const) {
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

test("verifier results reject retired fixed checkpoints", () => {
  expect(reviewRoundResultSchema.options.map((option) => option.shape.kind.value)).toEqual([
    "accepted",
    "suggestions",
    "rejected",
  ]);
  expect(reviewRoundResultSchema.safeParse({ kind: "fixed" }).success).toBe(false);
});

test("task images are both roles by digest in the task image repository", () => {
  const repository = "us-central1-docker.pkg.dev/selfbench-prod/selfbench-tasks";
  const images = {
    agent: `${repository}/task-1@sha256:${"a".repeat(64)}`,
    verifier: `${repository}/task-1@sha256:${"b".repeat(64)}`,
  };
  expect(taskImagesSchema.parse(images)).toEqual(images);
  // Both images are required, and a tag can move under a task; only a digest names what the
  // checks passed on.
  expect(taskImagesSchema.safeParse({ agent: images.agent }).success).toBe(false);
  expect(
    taskImagesSchema.safeParse({ ...images, agent: `${repository}/task-1:latest` }).success,
  ).toBe(false);
});
