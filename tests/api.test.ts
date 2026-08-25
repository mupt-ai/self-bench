import { describe, expect, test } from "bun:test";
import { buildRunRequest } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { HOBBY_VERCEL_TIMEOUT_CAP_MS } from "../src/sandbox/timeout.js";

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

    expect(built.candidateCounts).toEqual({ easy: 3_334, medium: 3_333, hard: 3_333 });
    expect(() =>
      buildRunRequest(loadConfig(), {
        ...submission,
        candidateCounts: { easy: 3_334, medium: 3_334, hard: 3_333 },
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
      schema: 1,
    });
  });

  test("does not add Vercel timeout metadata to other providers", () => {
    const version = buildRunRequest(
      loadConfig({ SELFBENCH_BUILD_COMMIT: "e".repeat(40) }),
      submission,
    ).version;

    expect(version.executionBackend).toBe("docker");
    expect(version).not.toHaveProperty("sandboxTimeoutCapMs");
  });
});
