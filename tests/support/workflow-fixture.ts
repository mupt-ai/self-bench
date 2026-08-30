import type { ArtifactRef, Candidate, Difficulty, RunRequest } from "../../src/contracts.js";
import type { SelfBenchActivities } from "../../src/temporal/activities.js";

export const artifact: ArtifactRef = {
  uri: "file:///artifact",
  sha256: "a".repeat(64),
  sizeBytes: 1,
  contentType: "application/json",
};

export const combinedProvenance: ArtifactRef = {
  ...artifact,
  uri: "file:///combined-provenance.jsonl",
  contentType: "application/x-ndjson",
};

export const run: RunRequest = {
  runId: "workflow-test",
  repository: { url: "https://github.com/example/repo.git", commit: "a".repeat(40) },
  provenance: artifact,
  candidateCounts: { easy: 0, medium: 0, hard: 1 },
  authoring: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
  version: {
    selfbenchCommit: "b".repeat(40),
    executionBackend: "docker",
    harborEnvironment: "docker",
    sandboxImage: "selfbench-sandbox:local",
    schema: 2,
  },
};

export function candidate(
  id: string,
  sourcePr: number,
  difficulty: Difficulty = "hard",
): Candidate {
  return {
    candidateId: id,
    difficulty,
    sourcePr,
    sourceUrl: `https://github.com/example/repo/pull/${sourcePr}`,
    baseCommit: "c".repeat(40),
    completedCommit: "d".repeat(40),
    request: "Implement behavior",
    provenance: artifact,
  };
}

export function acceptingActivities(discovered: readonly Candidate[]): SelfBenchActivities {
  return {
    collectRunProvenance: async () => artifact,
    discoverCandidateShard: async ({ shardIndex }) => ({
      candidates: shardIndex === 0 ? discovered : [],
      report: artifact,
    }),
    authorCandidate: async ({ candidate: value }) => ({
      kind: "authored",
      task: {
        candidateId: value.candidateId,
        taskId: `${value.candidateId}-task`,
        definition: artifact,
        sourceBundle: artifact,
      },
    }),
    authorEnvironment: async ({ task }) => ({
      kind: "authored",
      task: { ...task, bundle: artifact },
    }),
    preflightEnvironment: async ({ task }) => ({
      taskId: task.taskId,
      accepted: true,
      report: artifact,
    }),
    auditTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
    validateTask: async ({ task }) => ({
      taskId: task.taskId,
      accepted: true,
      nop: { passed: true, result: artifact },
      oracle: { passed: true, result: artifact },
    }),
    repairValidationTask: async () => {
      throw new Error("unexpected validation repair");
    },
    reviewTask: async ({ task }) => ({ taskId: task.taskId, accepted: true, report: artifact }),
    repairTask: async () => {
      throw new Error("unexpected repair");
    },
    buildExport: async () => artifact,
  };
}
