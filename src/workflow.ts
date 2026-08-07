import {
  ActivityFailure,
  ApplicationFailure,
  defineQuery,
  isCancellation,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type {
  AuthorCandidateInput,
  DiscoveryShardInput,
  ExportInput,
  RepairTaskInput,
  SelfBenchActivities,
  TaskStageInput,
} from "./activities.js";
import type {
  AuthoredTask,
  Candidate,
  DiscoveryProgress,
  RunRequest,
  RunResult,
  RunStatus,
  TaskProgress,
} from "./contracts.js";

export const statusQuery = defineQuery<RunStatus>("status");

const taskActivities = proxyActivities<Omit<SelfBenchActivities, "discoverCandidateShard">>({
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
  reviewTask: taskActivities.reviewTask,
  repairTask: taskActivities.repairTask,
  auditTask: taskActivities.auditTask,
  buildExport: taskActivities.buildExport,
};

const DISCOVERY_EXPANSION_SIZE = 20;
const DISCOVERY_SHARD_COUNT = 8;
const DISCOVERY_SHARD_OVERFETCH = 3;
const MAX_CANDIDATES_PER_SHARD = 8;
const MAX_DISCOVERED_CANDIDATES = 100;

export async function selfBenchRunWorkflow(input: RunRequest): Promise<RunResult> {
  return await executeRun(input, activities, (status) => setHandler(statusQuery, () => status()));
}

export async function executeRun(
  input: RunRequest,
  activitySet: SelfBenchActivities,
  installStatusQuery: (status: () => RunStatus) => void = () => undefined,
): Promise<RunResult> {
  let status: RunStatus = {
    runId: input.runId,
    phase: "queued",
    requested: input.count,
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
    const candidates = await discoverWave(activitySet, input, {
      wave: 0,
      targetCount: Math.min(input.count + input.reserveCount, MAX_DISCOVERED_CANDIDATES),
      excludedSourcePrs: [],
      onProgress: updateDiscovery,
    });
    setDiscovered(candidates.length);
    const taskProgress: TaskProgress[] = [];
    const acceptedTasks: AuthoredTask[] = [];
    const taskIds = new Set<string>();
    let cursor = 0;
    let expansionPage = 0;

    const rejectProgress = (progress: TaskProgress, reason: string): void => {
      progress.status = "rejected";
      progress.reason = reason;
      setTasks(taskProgress);
    };
    const processCandidate = async (candidate: Candidate): Promise<void> => {
      const progress: TaskProgress = {
        candidateId: candidate.candidateId,
        taskId: candidate.candidateId,
        status: "authoring",
      };
      taskProgress.push(progress);
      setTasks(taskProgress);
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
      const validation = await activitySet.validateTask({
        run: input,
        task,
      } satisfies TaskStageInput);
      if (!validation.accepted) {
        rejectProgress(progress, validation.reason ?? "validation rejected task");
        return;
      }

      progress.status = "reviewing";
      setTasks(taskProgress);
      let review = await activitySet.reviewTask({ run: input, task } satisfies TaskStageInput);
      if (!review.accepted) {
        progress.status = "repairing";
        setTasks(taskProgress);
        const repaired = await activitySet.repairTask({
          run: input,
          task,
          review: review.report,
        } satisfies RepairTaskInput);
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
          rejectProgress(progress, repairValidation.reason ?? "validation rejected repaired task");
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
    };

    while (acceptedTasks.length < input.count) {
      if (cursor >= candidates.length) {
        const capacity = MAX_DISCOVERED_CANDIDATES - candidates.length;
        if (capacity <= 0) {
          setPhase("blocked");
          throw ApplicationFailure.nonRetryable(
            `candidate pool exhausted at ${acceptedTasks.length}/${input.count} accepted tasks`,
            "CandidatePoolExhausted",
          );
        }
        expansionPage += 1;
        setPhase("discovering");
        const additions = await discoverWave(activitySet, input, {
          wave: expansionPage,
          excludedSourcePrs: candidates.map((candidate) => candidate.sourcePr),
          targetCount: Math.min(DISCOVERY_EXPANSION_SIZE, capacity),
          onProgress: updateDiscovery,
        });
        const knownPrs = new Set(candidates.map((candidate) => candidate.sourcePr));
        const uniqueAdditions = additions.filter((candidate) => !knownPrs.has(candidate.sourcePr));
        if (uniqueAdditions.length === 0) {
          setPhase("blocked");
          throw ApplicationFailure.nonRetryable(
            `discovery expansion produced no new candidates at ${acceptedTasks.length}/${input.count}`,
            "CandidatePoolExhausted",
          );
        }
        candidates.push(...uniqueAdditions);
        setDiscovered(candidates.length);
      }
      setPhase("authoring");
      const workerCount = Math.min(input.count - acceptedTasks.length, candidates.length - cursor);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (acceptedTasks.length < input.count) {
            const candidate = candidates[cursor];
            if (!candidate) {
              return;
            }
            cursor += 1;
            await processCandidate(candidate);
          }
        }),
      );
    }

    const selected = acceptedTasks.slice(0, input.count);
    setPhase("exporting");
    const exportRef = await activitySet.buildExport({
      run: input,
      tasks: selected,
    } satisfies ExportInput);
    status = { ...status, phase: "complete", export: exportRef };
    return {
      runId: input.runId,
      export: exportRef,
      acceptedTaskIds: selected.map((task) => task.taskId),
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
  readonly targetCount: number;
  readonly excludedSourcePrs: readonly number[];
  readonly onProgress: (progress: DiscoveryProgress) => void;
}

async function discoverWave(
  activitySet: SelfBenchActivities,
  run: RunRequest,
  options: DiscoveryWaveOptions,
): Promise<Candidate[]> {
  const targetPerShard = Math.min(
    MAX_CANDIDATES_PER_SHARD,
    Math.max(1, Math.ceil(options.targetCount / DISCOVERY_SHARD_COUNT) + DISCOVERY_SHARD_OVERFETCH),
  );
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
          targetCount: targetPerShard,
          excludedSourcePrs: options.excludedSourcePrs,
        } satisfies DiscoveryShardInput);
        completedShards += 1;
        candidateCount += result.candidates.length;
        reportProgress();
        return result;
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        if (isNonRetryableActivityFailure(error)) {
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

function isNonRetryableActivityFailure(error: unknown): boolean {
  if (!(error instanceof ActivityFailure)) {
    return false;
  }
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    if (cause instanceof ApplicationFailure) {
      return cause.nonRetryable === true;
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
