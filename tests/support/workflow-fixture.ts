import type {
  ArtifactRef,
  AuthoredTaskDraft,
  Candidate,
  Difficulty,
  RunRequest,
  VerifyOutcome,
  VerifyReport,
  VerifyStage,
} from "../../src/contracts.js";
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

export function ref(uri: string): ArtifactRef {
  return { ...artifact, uri };
}

export function draft(candidateId: string, suffix = ""): AuthoredTaskDraft {
  return {
    candidateId,
    taskId: `${candidateId}-task`,
    definition: ref(`file:///${candidateId}${suffix}/definition.json`),
    sourceBundle: ref(`file:///${candidateId}${suffix}/source-task.tar.gz`),
  };
}

export function greenReport(stage: VerifyStage, round: number, taskId: string): VerifyReport {
  const gate = { ran: true, ok: true, logTail: "" };
  return {
    schemaVersion: 1,
    stage,
    round,
    taskId,
    compile: { ok: true, errors: [] },
    audit: { ok: true, blockers: [] },
    build: { ...gate, infrastructure: false },
    smoke: gate,
    nop: {
      ...gate,
      rewards: { patch_applied: 1, setup_completed: 1, fail_to_pass: 0, pass_to_pass: 1 },
    },
    oracle: {
      ...gate,
      rewards: {
        patch_applied: 1,
        setup_completed: 1,
        fail_to_pass: 1,
        pass_to_pass: 1,
        deterministic: 1,
      },
    },
    green: true,
  };
}

export function redReport(
  stage: VerifyStage,
  round: number,
  taskId: string,
  failure: { compile?: string; infrastructure?: string; oracle?: boolean },
): VerifyReport {
  const green = greenReport(stage, round, taskId);
  const notRun = { ran: false, ok: false, logTail: "" };
  if (failure.compile) {
    return {
      ...green,
      compile: { ok: false, errors: [failure.compile] },
      build: { ...notRun, infrastructure: false },
      smoke: notRun,
      nop: { ...notRun, rewards: {} },
      oracle: { ...notRun, rewards: {} },
      green: false,
    };
  }
  if (failure.infrastructure) {
    return {
      ...green,
      build: { ran: true, ok: false, infrastructure: true, logTail: failure.infrastructure },
      smoke: notRun,
      nop: { ...notRun, rewards: {} },
      oracle: { ...notRun, rewards: {} },
      green: false,
    };
  }
  return {
    ...green,
    oracle: { ...green.oracle, ok: false, rewards: { ...green.oracle.rewards, fail_to_pass: 0 } },
    green: false,
  };
}

export function greenOutcome(
  task: AuthoredTaskDraft,
  stage: VerifyStage,
  round: number,
): VerifyOutcome {
  return {
    report: greenReport(stage, round, task.taskId),
    reportRef: ref(`file:///${task.candidateId}/${stage}-round-${round}/report.json`),
    task: {
      ...task,
      bundle: ref(`file:///${task.candidateId}/${stage}-round-${round}/harbor-task.tar.gz`),
    },
  };
}

export function acceptingActivities(discovered: readonly Candidate[]): SelfBenchActivities {
  return {
    collectRunProvenance: async () => artifact,
    discoverCandidateShard: async ({ shardIndex }) => ({
      candidates: shardIndex === 0 ? discovered : [],
      report: artifact,
    }),
    runAuthoringRound: async ({ candidate: value, round }) => ({
      kind: "submitted",
      task: draft(value.candidateId),
      session: ref(`file:///${value.candidateId}/authoring/session/round-${round}.jsonl`),
    }),
    compileAndVerify: async ({ task, stage, round }) => greenOutcome(task, stage, round),
    runVerifierRound: async ({ candidate: value, round }) => ({
      kind: "accepted",
      session: ref(`file:///${value.candidateId}/verification/session/round-${round}.jsonl`),
      reason: "fair benchmark",
    }),
    buildExport: async () => artifact,
  };
}
