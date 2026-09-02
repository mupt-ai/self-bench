import { isCancellation } from "@temporalio/workflow";
import type {
  AuthoredTask,
  Candidate,
  DiscoveryProgress,
  RunRequest,
  RunResult,
  RunStatus,
  TaskProgress,
} from "../../contracts.js";
import { parallelMap } from "../../parallel.js";
import type { ExportInput, SelfBenchActivities } from "../activities.js";
import { createCandidateProcessor } from "./candidate.js";
import {
  candidatePoolExhausted,
  discoverWave,
  MAX_CONCURRENT_CANDIDATES,
  MAX_DISCOVERED_CANDIDATES,
  missingCandidateCounts,
  selectCandidates,
} from "./discovery.js";

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
    const provenance = await activitySet.collectRunProvenance(input);
    const run = { ...input, provenance };
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
      const additions = await discoverWave(activitySet, run, {
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
    const taskProgress: TaskProgress[] = [];
    const acceptedTasks: AuthoredTask[] = [];
    const processCandidate = createCandidateProcessor({
      activitySet,
      run,
      taskProgress,
      acceptedTasks,
      taskIds: new Map(),
      setTasks,
    });

    setPhase("authoring");
    await processWithBackfill(candidates, input.candidateCounts, taskProgress, processCandidate);

    setPhase("exporting");
    const exportRef = await activitySet.buildExport({
      run,
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

/**
 * Processes the first selection, then keeps replacing rejected or failed candidates from the
 * leftover discovery pool until every tier has the requested number of accepted tasks or the
 * pool has no unused candidate of a missing tier.
 */
async function processWithBackfill(
  pool: readonly Candidate[],
  requested: RunRequest["candidateCounts"],
  taskProgress: readonly TaskProgress[],
  processCandidate: (candidate: Candidate) => Promise<void>,
): Promise<void> {
  const processed = new Set<string>();
  let batch = selectCandidates(pool, requested);
  while (batch.length > 0) {
    for (const candidate of batch) {
      processed.add(candidate.candidateId);
    }
    await parallelMap(batch, MAX_CONCURRENT_CANDIDATES, processCandidate);
    const accepted = taskProgress.filter((task) => task.status === "accepted");
    const missing = missingCandidateCounts(
      accepted.map((task) => ({ difficulty: task.difficulty })),
      requested,
    );
    batch = selectCandidates(
      pool.filter((candidate) => !processed.has(candidate.candidateId)),
      {
        easy: Math.max(0, missing.easy),
        medium: Math.max(0, missing.medium),
        hard: Math.max(0, missing.hard),
      },
    );
  }
}
