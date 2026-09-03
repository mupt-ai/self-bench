import { isCancellation } from "@temporalio/workflow";
import {
  type Candidate,
  type Difficulty,
  type DiscoveryProgress,
  isReplayRunRequest,
  type RunRequest,
  type RunResult,
  type RunStatus,
  type TaskProgress,
  type WorkflowRunInput,
} from "../../contracts.js";
import { parallelMap } from "../../parallel.js";
import type { ExportInput, SelfBenchActivities } from "../activities.js";
import {
  type CandidateChildren,
  createCandidateTracker,
  inProcessCandidates,
} from "./candidate-tracker.js";
import {
  candidatePoolExhausted,
  discoverWave,
  MAX_CONCURRENT_CANDIDATES,
  MAX_DISCOVERED_CANDIDATES,
  missingCandidateCounts,
  selectCandidates,
} from "./discovery.js";

export async function executeRun(
  input: WorkflowRunInput,
  activitySet: SelfBenchActivities,
  installStatusQuery: (status: () => RunStatus) => void = () => undefined,
  children: CandidateChildren = inProcessCandidates(activitySet),
): Promise<RunResult> {
  const requestedCounts = isReplayRunRequest(input)
    ? { easy: 0, medium: 0, hard: 0 }
    : input.candidateCounts;
  let status: RunStatus = {
    runId: input.runId,
    phase: "queued",
    requested: sum(requestedCounts),
    requestedByDifficulty: requestedCounts,
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
  const tracker = createCandidateTracker(children, setTasks);

  try {
    setPhase("discovering");
    let run: RunRequest;
    let candidates: Candidate[];
    if (isReplayRunRequest(input)) {
      const material = await activitySet.rebuildReplayCandidates(input);
      candidates = [...material.candidates];
      const candidateCounts = countByDifficulty(candidates);
      run = {
        runId: input.runId,
        repository: material.repository,
        provenance: material.provenance,
        candidateCounts,
        authoring: input.authoring,
        version: input.version,
      };
      status = {
        ...status,
        requested: candidates.length,
        requestedByDifficulty: candidateCounts,
        discovered: candidates.length,
      };
    } else {
      const [provenance, excludedSourcePrs] = await Promise.all([
        activitySet.collectRunProvenance(input),
        input.excludeRuns && input.excludeRuns.length > 0
          ? activitySet.collectExcludedSourcePrs(input.excludeRuns)
          : Promise.resolve([]),
      ]);
      run = { ...input, provenance };
      candidates = await discoverUntilFilled(
        activitySet,
        run,
        input,
        excludedSourcePrs,
        (progress) => {
          status = { ...status, discovery: progress };
        },
        setDiscovered,
        setPhase,
      );
    }
    const processCandidate = (candidate: Candidate): Promise<void> =>
      tracker.process(run, candidate);

    setPhase("authoring");
    // Every candidate, discovered or replayed, runs as its own child workflow at once. The
    // requested counts size discovery's pool; they are not a cap on accepted tasks, so a pool that
    // yields more than requested simply exports more.
    await parallelMap(candidates, MAX_CONCURRENT_CANDIDATES, processCandidate);

    setPhase("exporting");
    const exportRef = await activitySet.buildExport({
      run,
      tasks: tracker.acceptedTasks,
    } satisfies ExportInput);
    status = { ...status, phase: "complete", export: exportRef };
    return {
      runId: input.runId,
      export: exportRef,
      acceptedTaskIds: tracker.acceptedTasks.map((task) => task.taskId),
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
 * Discovers in waves until every tier is filled. `excludedSourcePrs` (PRs earlier runs processed)
 * is sent to every wave and never enters the pool, even if a shard returns one anyway.
 */
async function discoverUntilFilled(
  activitySet: SelfBenchActivities,
  run: RunRequest,
  input: RunRequest,
  excludedSourcePrs: readonly number[],
  updateDiscovery: (progress: DiscoveryProgress) => void,
  setDiscovered: (discovered: number) => void,
  setPhase: (phase: RunStatus["phase"]) => void,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const excluded = new Set(excludedSourcePrs);
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
      excludedSourcePrs: [...excluded, ...candidates.map((candidate) => candidate.sourcePr)],
      onProgress: updateDiscovery,
    });
    const knownPrs = new Set(candidates.map((candidate) => candidate.sourcePr));
    const uniqueAdditions = additions.filter(
      (candidate) => !knownPrs.has(candidate.sourcePr) && !excluded.has(candidate.sourcePr),
    );
    if (uniqueAdditions.length === 0) {
      setPhase("blocked");
      throw candidatePoolExhausted(selected, input.candidateCounts);
    }
    candidates.push(...uniqueAdditions.slice(0, capacity));
    setDiscovered(candidates.length);
    discoveryWave += 1;
  }
  return candidates;
}

function countByDifficulty(candidates: readonly Candidate[]): Record<Difficulty, number> {
  const counts: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
  for (const candidate of candidates) {
    counts[candidate.difficulty] += 1;
  }
  return counts;
}

function sum(counts: Record<Difficulty, number>): number {
  return counts.easy + counts.medium + counts.hard;
}
