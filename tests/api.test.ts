import { describe, expect, test } from "bun:test";
import { buildRunRequest } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { HOBBY_E2B_TIMEOUT_CAP_MS, HOBBY_VERCEL_TIMEOUT_CAP_MS } from "../src/sandbox/timeout.js";

const submission = {
  runId: "run-timeout-metadata",
  repository: { url: "https://github.com/example/repo.git", commit: "a".repeat(40) },
  provenance: {
    uri: "file:///provenance.jsonl",
    sha256: "b".repeat(64),
    sizeBytes: 1,
    contentType: "application/x-ndjson",
  },
  candidateCounts: { easy: 1, medium: 0, hard: 0 },
  authoringModel: "gpt-5.6-sol",
  selfbenchCommit: "c".repeat(40),
};

describe("API run metadata", () => {
  test("accepts up to ten thousand candidates", () => {
    const built = buildRunRequest(loadConfig(), {
      ...submission,
      candidateCounts: { easy: 3_334, medium: 3_333, hard: 3_333 },
    });

    expect("candidateCounts" in built ? built.candidateCounts : undefined).toEqual({
      easy: 3_334,
      medium: 3_333,
      hard: 3_333,
    });
    expect(() =>
      buildRunRequest(loadConfig(), {
        ...submission,
        candidateCounts: { easy: 3_334, medium: 3_334, hard: 3_333 },
      }),
    ).toThrow();
  });

  test("carries excluded runs into the request and omits an empty list", () => {
    const built = buildRunRequest(loadConfig(), {
      ...submission,
      excludeRuns: ["posthog-agent-pipeline-20-v1", "posthog-agent-pipeline-replay-v1"],
    });

    expect("excludeRuns" in built ? built.excludeRuns : undefined).toEqual([
      "posthog-agent-pipeline-20-v1",
      "posthog-agent-pipeline-replay-v1",
    ]);
    expect(buildRunRequest(loadConfig(), { ...submission, excludeRuns: [] })).not.toHaveProperty(
      "excludeRuns",
    );
    expect(() =>
      buildRunRequest(loadConfig(), { ...submission, excludeRuns: ["Not A Run Id"] }),
    ).toThrow();
  });

  test("builds a replay request that skips discovery inputs", () => {
    const built = buildRunRequest(loadConfig(), {
      runId: "replay-run",
      replay: { sourceRunId: "source-run", candidateIds: ["w0s1-alpha", "w1s3-beta"] },
      authoringModel: "gpt-5.6-sol",
      selfbenchCommit: "c".repeat(40),
    });

    expect(built).toEqual({
      runId: "replay-run",
      replay: { sourceRunId: "source-run", candidateIds: ["w0s1-alpha", "w1s3-beta"] },
      authoring: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      version: expect.objectContaining({ selfbenchCommit: "c".repeat(40), schema: 2 }),
    });
    expect(() =>
      buildRunRequest(loadConfig(), {
        runId: "replay-run",
        replay: { sourceRunId: "source-run", candidateIds: [] },
        selfbenchCommit: "c".repeat(40),
      }),
    ).toThrow();
  });

  test("persists the effective Vercel timeout cap with provider and Harbor metadata", () => {
    const config = loadConfig({
      SELFBENCH_EXECUTION_BACKEND: "vercel",
      SELFBENCH_HARBOR_ENVIRONMENT: "modal",
      SELFBENCH_VERCEL_IMAGE: `selfbench-runtime@sha256:${"d".repeat(64)}`,
      SELFBENCH_VERCEL_TIMEOUT_CAP: "45m",
      SELFBENCH_BUILD_COMMIT: "e".repeat(40),
    });

    expect(buildRunRequest(config, submission).version).toEqual({
      selfbenchCommit: "e".repeat(40),
      executionBackend: "vercel",
      harborEnvironment: "modal",
      sandboxImage: `selfbench-runtime@sha256:${"d".repeat(64)}`,
      sandboxTimeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS,
      schema: 2,
    });
  });

  test("persists the effective E2B timeout cap and template metadata", () => {
    const config = loadConfig({
      SELFBENCH_EXECUTION_BACKEND: "e2b",
      SELFBENCH_HARBOR_ENVIRONMENT: "docker",
      SELFBENCH_E2B_TEMPLATE: "selfbench-runtime:v1",
      SELFBENCH_E2B_TIMEOUT_CAP: "1h",
      SELFBENCH_BUILD_COMMIT: "e".repeat(40),
    });

    expect(buildRunRequest(config, submission).version).toEqual({
      selfbenchCommit: "e".repeat(40),
      executionBackend: "e2b",
      harborEnvironment: "docker",
      sandboxImage: "selfbench-runtime:v1",
      sandboxTimeoutCapMs: HOBBY_E2B_TIMEOUT_CAP_MS,
      schema: 2,
    });
  });

  test("does not add hosted-provider timeout metadata to Docker", () => {
    const version = buildRunRequest(
      loadConfig({ SELFBENCH_BUILD_COMMIT: "e".repeat(40) }),
      submission,
    ).version;

    expect(version.executionBackend).toBe("docker");
    expect(version).not.toHaveProperty("sandboxTimeoutCapMs");
  });
});
