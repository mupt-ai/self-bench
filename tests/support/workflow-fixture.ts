import type {
  ArtifactRef,
  AuthoredTaskDraft,
  Candidate,
  Difficulty,
  PipelineStage,
  RunRequest,
  RunStatus,
  TaskProgress,
  VerifyOutcome,
  VerifyReport,
} from "../../src/contracts/index.js";
import type {
  DiscoveryShardInput,
  SelfBenchActivities,
} from "../../src/generation/pipeline/activities.js";
import { executeCandidate } from "../../src/generation/pipeline/workflows.js";

export const artifact: ArtifactRef = {
  uri: "file:///artifact",
  sha256: "a".repeat(64),
  sizeBytes: 1,
  contentType: "application/json",
};

export const run: RunRequest = {
  runId: "workflow-test",
  repository: { url: "https://github.com/example/repo.git", commit: "a".repeat(40) },
  provenance: artifact,
  candidateCounts: { easy: 0, medium: 0, hard: 1 },
  authoring: { provider: "openai-codex", model: "gpt-6-sol", reasoningEffort: "high" },
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

function greenReport(stage: PipelineStage, round: number, taskId: string): VerifyReport {
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
  stage: PipelineStage,
  round: number,
  taskId: string,
  failure: { compile?: string; oracle?: boolean },
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
  return {
    ...green,
    oracle: { ...green.oracle, ok: false, rewards: { ...green.oracle.rewards, fail_to_pass: 0 } },
    green: false,
  };
}

export function greenOutcome(
  task: AuthoredTaskDraft,
  stage: PipelineStage,
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
    discoverCandidateShard: async ({ shardIndex }) => ({
      candidates: shardIndex === 0 ? discovered : [],
      report: artifact,
    }),
    runAuthoringTurn: async ({ candidate: value, round }) => ({
      kind: "submitted",
      task: draft(value.candidateId),
      session: ref(`file:///${value.candidateId}/authoring/session/round-${round}.jsonl`),
    }),
    compileAndVerify: async ({ task, stage, round }) => greenOutcome(task, stage, round),
    runReviewRound: async ({ candidate: value, round }) => ({
      kind: "accepted",
      session: ref(`file:///${value.candidateId}/review/session/round-${round}.jsonl`),
      reason: "fair benchmark",
    }),
  };
}

/**
 * Runs each discovered candidate through the author/review loop the way selfBenchAuthorWorkflow
 * does, exposing the candidates' latest progress as a run status.
 */
export async function authorCandidates(
  activities: SelfBenchActivities,
  install?: (status: () => RunStatus) => void,
): Promise<{ acceptedTaskIds: string[] }> {
  const { candidates } = await activities.discoverCandidateShard({
    shardIndex: 0,
  } as DiscoveryShardInput);
  const tasks = new Map<string, TaskProgress>();
  install?.(() => ({ tasks: [...tasks.values()] }) as unknown as RunStatus);
  const results = await Promise.all(
    candidates.map((value) =>
      executeCandidate({ run, candidate: value }, activities, (progress) =>
        tasks.set(value.candidateId, progress),
      ),
    ),
  );
  return {
    acceptedTaskIds: results.flatMap((result) => (result.task ? [result.task.taskId] : [])),
  };
}
