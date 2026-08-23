import { RetryState } from "@temporalio/common";
import {
  ActivityFailure,
  ApplicationFailure,
  defineQuery,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type {
  AuthoredTask,
  AuthorOutcome,
  Candidate,
  Difficulty,
  DiscoveryProgress,
  RunRequest,
  RunResult,
  RunStatus,
  TaskProgress,
} from "../contracts.js";
import type {
  AuthorCandidateInput,
  DiscoveryShardInput,
  ExportInput,
  RepairTaskInput,
  SelfBenchActivities,
  TaskStageInput,
  ValidationRepairTaskInput,
} from "./activities.js";

export const statusQuery = defineQuery<RunStatus>("status");

const taskActivities = proxyActivities<
  Omit<SelfBenchActivities, "discoverCandidateShard" | "repairValidationTask">
>({
  startToCloseTimeout: "7 hours",
  heartbeatTimeout: "10 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: 4,
  },
});

const validationRepairActivity = proxyActivities<Pick<SelfBenchActivities, "repairValidationTask">>(
  {
    startToCloseTimeout: "2 hours",
    heartbeatTimeout: "10 minutes",
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
    retry: { maximumAttempts: 1 },
  },
);

const discoveryActivities = proxyActivities<Pick<SelfBenchActivities, "discoverCandidateShard">>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "10 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
  },
});

const activities: SelfBenchActivities = {
  discoverCandidateShard: discoveryActivities.discoverCandidateShard,
  authorCandidate: taskActivities.authorCandidate,
  validateTask: taskActivities.validateTask,
  repairValidationTask: validationRepairActivity.repairValidationTask,
  reviewTask: taskActivities.reviewTask,
  repairTask: taskActivities.repairTask,
  auditTask: taskActivities.auditTask,
  buildExport: taskActivities.buildExport,
};

const DISCOVERY_SHARD_COUNT = 8;
const DISCOVERY_SHARD_OVERFETCH = 3;
const MAX_CANDIDATES_PER_TIER_PER_SHARD = 8;
const MAX_DISCOVERED_CANDIDATES = 300;

export async function selfBenchRunWorkflow(input: RunRequest): Promise<RunResult> {
  return await executeRun(input, activities, (status) => setHandler(statusQuery, () => status()));
}

export async function executeRun(
  input: RunRequest,
  activitySet: SelfBenchActivities,
  installStatusQuery: (status: () => RunStatus) => void = () => undefined,
): Promise<RunResult> {
  const requested = Object.values(input.candidateCounts).reduce((sum, count) => sum + count, 0);
  let status: RunStatus = {
    runId: input.runId,
    phase: "queued",
    requested,
    requestedByDifficulty: input.candidateCounts,
    discovered: 0,
    accepted: 0,
    rejected: 0,
    tasks: [],
  };
  installStatusQuery(() => status);
  const setPhase = (phase: RunStatus["phase"]): void => {
    status = { ...status, phase };
  };
  const setTasks = (tasks: readonly TaskProgress[]): void => {
    status = {
      ...status,
      tasks,
      accepted: tasks.filter((task) => task.status === "accepted").length,
      rejected: tasks.filter((task) => task.status === "rejected").length,
    };
  };
  const setDiscovered = (discovered: number): void => {
    status = {
      ...status,
      discovered,
      ...(status.discovery ? { discovery: { ...status.discovery, candidates: discovered } } : {}),
    };
  };

  try {
    setPhase("discovering");
    const updateDiscovery = (progress: DiscoveryProgress): void => {
      status = { ...status, discovery: progress };
    };
    const candidates: Candidate[] = [];
    let discoveryWave = 0;
    while (true) {
      const selected = selectCandidates(candidates, input.candidateCounts);
      const missing = missingCandidateCounts(selected, input.candidateCounts);
      if (Object.values(missing).every((count) => count === 0)) {
        break;
      }
      const capacity = MAX_DISCOVERED_CANDIDATES - candidates.length;
      if (capacity <= 0) {
        setPhase("blocked");
        throw candidatePoolExhausted(selected, input.candidateCounts);
      }
      const additions = await discoverWave(activitySet, input, {
        wave: discoveryWave,
        targetCounts: missing,
        excludedSourcePrs: candidates.map((candidate) => candidate.sourcePr),
        onProgress: updateDiscovery,
      });
      const knownPrs = new Set(candidates.map((candidate) => candidate.sourcePr));
      const uniqueAdditions = additions.filter((candidate) => !knownPrs.has(candidate.sourcePr));
      if (uniqueAdditions.length === 0) {
        setPhase("blocked");
        throw candidatePoolExhausted(selected, input.candidateCounts);
      }
      candidates.push(...uniqueAdditions.slice(0, capacity));
      setDiscovered(candidates.length);
      discoveryWave += 1;
    }
    const selectedCandidates = selectCandidates(candidates, input.candidateCounts);
    const taskProgress: TaskProgress[] = [];
    const acceptedTasks: AuthoredTask[] = [];
    const taskIds = new Set<string>();

    const rejectProgress = (progress: TaskProgress, reason: string): void => {
      progress.status = "rejected";
      progress.reason = reason;
      setTasks(taskProgress);
    };
    const processCandidate = async (candidate: Candidate): Promise<void> => {
      const progress: TaskProgress = {
        candidateId: candidate.candidateId,
        taskId: candidate.candidateId,
        difficulty: candidate.difficulty,
        status: "authoring",
      };
      taskProgress.push(progress);
      setTasks(taskProgress);
      try {
        const authored = await activitySet.authorCandidate({
          run: input,
          candidate,
        } satisfies AuthorCandidateInput);
        if (authored.kind === "rejected") {
          rejectProgress(progress, authored.reason);
          return;
        }
        let task = authored.task;
        if (taskIds.has(task.taskId)) {
          rejectProgress(progress, `authoring repeated task ID ${task.taskId}`);
          return;
        }
        taskIds.add(task.taskId);
        progress.taskId = task.taskId;

        progress.status = "auditing";
        setTasks(taskProgress);
        const audit = await activitySet.auditTask({ run: input, task } satisfies TaskStageInput);
        if (!audit.accepted) {
          rejectProgress(progress, audit.reason ?? "audit rejected task");
          return;
        }

        progress.status = "validating";
        setTasks(taskProgress);
        let validation = await activitySet.validateTask({
          run: input,
          task,
        } satisfies TaskStageInput);
        if (!validation.accepted) {
          progress.status = "repairing";
          setTasks(taskProgress);
          let repaired: AuthorOutcome;
          try {
            repaired = await activitySet.repairValidationTask({
              run: input,
              task,
              validation,
            } satisfies ValidationRepairTaskInput);
          } catch (error) {
            if (isCancellation(error) || !isExhaustedActivityFailure(error)) {
              throw error;
            }
            rejectProgress(progress, "validation repair failed after its single activity attempt");
            return;
          }
          if (repaired.kind === "rejected") {
            rejectProgress(progress, repaired.reason);
            return;
          }
          task = repaired.task;

          progress.status = "auditing";
          setTasks(taskProgress);
          const repairAudit = await activitySet.auditTask({
            run: input,
            task,
          } satisfies TaskStageInput);
          if (!repairAudit.accepted) {
            rejectProgress(progress, repairAudit.reason ?? "audit rejected validation repair");
            return;
          }

          progress.status = "validating";
          setTasks(taskProgress);
          validation = await activitySet.validateTask({
            run: input,
            task,
          } satisfies TaskStageInput);
          if (!validation.accepted) {
            rejectProgress(progress, validation.reason ?? "validation rejected repaired harness");
            return;
          }
        }

        progress.status = "reviewing";
        setTasks(taskProgress);
        let review = await activitySet.reviewTask({ run: input, task } satisfies TaskStageInput);
        if (!review.accepted) {
          progress.status = "repairing";
          setTasks(taskProgress);
          let repaired: AuthorOutcome;
          try {
            repaired = await activitySet.repairTask({
              run: input,
              task,
              review: review.report,
            } satisfies RepairTaskInput);
          } catch (error) {
            if (isCancellation(error) || !isExhaustedActivityFailure(error)) {
              throw error;
            }
            rejectProgress(progress, "test repair failed after activity retries");
            return;
          }
          if (repaired.kind === "rejected") {
            rejectProgress(progress, repaired.reason);
            return;
          }
          task = repaired.task;

          progress.status = "auditing";
          setTasks(taskProgress);
          const repairAudit = await activitySet.auditTask({
            run: input,
            task,
          } satisfies TaskStageInput);
          if (!repairAudit.accepted) {
            rejectProgress(progress, repairAudit.reason ?? "audit rejected repaired task");
            return;
          }

          progress.status = "validating";
          setTasks(taskProgress);
          const repairValidation = await activitySet.validateTask({
            run: input,
            task,
          } satisfies TaskStageInput);
          if (!repairValidation.accepted) {
            rejectProgress(
              progress,
              repairValidation.reason ?? "validation rejected repaired task",
            );
            return;
          }

          progress.status = "reviewing";
          setTasks(taskProgress);
          review = await activitySet.reviewTask({ run: input, task } satisfies TaskStageInput);
          if (!review.accepted) {
            rejectProgress(progress, review.reason ?? "review rejected repaired task");
            return;
          }
        }

        progress.status = "accepted";
        acceptedTasks.push(task);
        setTasks(taskProgress);
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        if (!isExhaustedActivityFailure(error) && !isHarborInfrastructureFailure(error)) {
          throw error;
        }
        progress.status = "infrastructure_failed";
        progress.reason = infrastructureFailureMessage(error);
        setTasks(taskProgress);
      }
    };

    setPhase("authoring");
    await Promise.all(selectedCandidates.map(processCandidate));

    setPhase("exporting");
    const exportRef = await activitySet.buildExport({
      run: input,
      tasks: acceptedTasks,
    } satisfies ExportInput);
    status = { ...status, phase: "complete", export: exportRef };
    return {
      runId: input.runId,
      export: exportRef,
      acceptedTaskIds: acceptedTasks.map((task) => task.taskId),
    };
  } catch (error) {
    if (isCancellation(error)) {
      status = { ...status, phase: "cancelled" };
    } else if (status.phase !== "blocked") {
      status = {
        ...status,
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}

interface DiscoveryWaveOptions {
  readonly wave: number;
  readonly targetCounts: RunRequest["candidateCounts"];
  readonly excludedSourcePrs: readonly number[];
  readonly onProgress: (progress: DiscoveryProgress) => void;
}

async function discoverWave(
  activitySet: SelfBenchActivities,
  run: RunRequest,
  options: DiscoveryWaveOptions,
): Promise<Candidate[]> {
  const targetCounts = Object.fromEntries(
    (["easy", "medium", "hard"] as const).map((difficulty) => [
      difficulty,
      options.targetCounts[difficulty] === 0
        ? 0
        : Math.min(
            MAX_CANDIDATES_PER_TIER_PER_SHARD,
            Math.ceil(options.targetCounts[difficulty] / DISCOVERY_SHARD_COUNT) +
              DISCOVERY_SHARD_OVERFETCH,
          ),
    ]),
  ) as Record<Difficulty, number>;
  let completedShards = 0;
  let failedShards = 0;
  let candidateCount = 0;
  const reportProgress = (): void =>
    options.onProgress({
      wave: options.wave,
      totalShards: DISCOVERY_SHARD_COUNT,
      completedShards,
      failedShards,
      candidates: candidateCount,
    });
  reportProgress();
  const shards = await Promise.all(
    Array.from({ length: DISCOVERY_SHARD_COUNT }, async (_unused, shardIndex) => {
      try {
        const result = await activitySet.discoverCandidateShard({
          run,
          wave: options.wave,
          shardIndex,
          shardCount: DISCOVERY_SHARD_COUNT,
          targetCounts,
          excludedSourcePrs: options.excludedSourcePrs,
        } satisfies DiscoveryShardInput);
        completedShards += 1;
        candidateCount += result.candidates.length;
        reportProgress();
        return result;
      } catch (error) {
        if (isCancellation(error) || !isExhaustedActivityFailure(error)) {
          throw error;
        }
        failedShards += 1;
        reportProgress();
        return { candidates: [], report: undefined };
      }
    }),
  );
  const ranked = interleave(shards.map((shard) => shard.candidates));
  const seenPrs = new Set<number>();
  return ranked.filter((candidate) => {
    if (seenPrs.has(candidate.sourcePr)) {
      return false;
    }
    seenPrs.add(candidate.sourcePr);
    return true;
  });
}

function selectCandidates(
  candidates: readonly Candidate[],
  counts: RunRequest["candidateCounts"],
): Candidate[] {
  const selectedCounts: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
  return candidates.filter((candidate) => {
    if (selectedCounts[candidate.difficulty] >= counts[candidate.difficulty]) {
      return false;
    }
    selectedCounts[candidate.difficulty] += 1;
    return true;
  });
}

function missingCandidateCounts(
  selected: readonly Candidate[],
  requested: RunRequest["candidateCounts"],
): Record<Difficulty, number> {
  const actual: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
  for (const candidate of selected) {
    actual[candidate.difficulty] += 1;
  }
  return {
    easy: requested.easy - actual.easy,
    medium: requested.medium - actual.medium,
    hard: requested.hard - actual.hard,
  };
}

function candidatePoolExhausted(
  selected: readonly Candidate[],
  requested: RunRequest["candidateCounts"],
): ApplicationFailure {
  const missing = missingCandidateCounts(selected, requested);
  return ApplicationFailure.nonRetryable(
    `candidate pool exhausted; missing easy=${missing.easy}, medium=${missing.medium}, hard=${missing.hard}`,
    "CandidatePoolExhausted",
  );
}

function isExhaustedActivityFailure(error: unknown): error is ActivityFailure {
  return (
    error instanceof ActivityFailure && error.retryState === RetryState.MAXIMUM_ATTEMPTS_REACHED
  );
}

function infrastructureFailureMessage(error: unknown): string {
  let cause = error;
  let message = error instanceof Error ? error.message : String(error);
  while (cause instanceof Error) {
    if (cause instanceof ApplicationFailure && cause.type === "HarborInfrastructureFailure") {
      return cause.message;
    }
    message = cause.message;
    cause = cause.cause;
  }
  return message;
}

function isHarborInfrastructureFailure(error: unknown): boolean {
  let cause = error;
  while (cause instanceof Error) {
    if (cause instanceof ApplicationFailure && cause.type === "HarborInfrastructureFailure") {
      return true;
    }
    cause = cause.cause;
  }
  return false;
}

function interleave<T>(groups: readonly (readonly T[])[]): T[] {
  const output: T[] = [];
  const maxLength = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      const value = group[index];
      if (value !== undefined) {
        output.push(value);
      }
    }
  }
  return output;
}
