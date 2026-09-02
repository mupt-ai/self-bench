import { ApplicationFailure } from "@temporalio/common";
import { isCancellation } from "@temporalio/workflow";
import type {
  Candidate,
  Difficulty,
  DiscoveryProgress,
  DiscoveryResult,
  RunRequest,
} from "../../contracts.js";
import { MAX_CANDIDATES_PER_RUN } from "../../contracts.js";
import type { DiscoveryShardInput, SelfBenchActivities } from "../activities.js";
import { isExhaustedActivityFailure } from "./failures.js";

const DISCOVERY_SHARD_COUNT = 8;
const DISCOVERY_SHARD_OVERFETCH = 3;
const MAX_CANDIDATES_PER_TIER_PER_SHARD = 8;
export const MAX_DISCOVERED_CANDIDATES = MAX_CANDIDATES_PER_RUN * 3;
export const MAX_CONCURRENT_CANDIDATES = 100;

interface DiscoveryWaveOptions {
  readonly wave: number;
  readonly targetCounts: RunRequest["candidateCounts"];
  readonly excludedSourcePrs: readonly number[];
  readonly onProgress: (progress: DiscoveryProgress) => void;
}

export async function discoverWave(
  activitySet: SelfBenchActivities,
  run: RunRequest,
  options: DiscoveryWaveOptions,
): Promise<Candidate[]> {
  const targetCounts = discoveryShardTargets(options.targetCounts);
  const progress = discoveryProgress(options);
  progress.report();

  const shards = await Promise.all(
    Array.from({ length: DISCOVERY_SHARD_COUNT }, (_unused, shardIndex) =>
      discoverShard(activitySet, run, options, targetCounts, shardIndex, progress),
    ),
  );
  return uniqueCandidates(interleave(shards.map((shard) => shard.candidates)));
}

function discoveryShardTargets(
  targetCounts: RunRequest["candidateCounts"],
): Record<Difficulty, number> {
  return Object.fromEntries(
    (["easy", "medium", "hard"] as const).map((difficulty) => [
      difficulty,
      targetCounts[difficulty] === 0
        ? 0
        : Math.min(
            MAX_CANDIDATES_PER_TIER_PER_SHARD,
            Math.ceil(targetCounts[difficulty] / DISCOVERY_SHARD_COUNT) + DISCOVERY_SHARD_OVERFETCH,
          ),
    ]),
  ) as Record<Difficulty, number>;
}

function discoveryProgress(options: DiscoveryWaveOptions) {
  let completedShards = 0;
  let failedShards = 0;
  let candidates = 0;
  const report = (): void =>
    options.onProgress({
      wave: options.wave,
      totalShards: DISCOVERY_SHARD_COUNT,
      completedShards,
      failedShards,
      candidates,
    });

  return {
    report,
    complete(candidateCount: number): void {
      completedShards += 1;
      candidates += candidateCount;
      report();
    },
    fail(): void {
      failedShards += 1;
      report();
    },
  };
}

async function discoverShard(
  activitySet: SelfBenchActivities,
  run: RunRequest,
  options: DiscoveryWaveOptions,
  targetCounts: Readonly<Record<Difficulty, number>>,
  shardIndex: number,
  progress: ReturnType<typeof discoveryProgress>,
): Promise<Pick<DiscoveryResult, "candidates">> {
  try {
    const result = await activitySet.discoverCandidateShard({
      run,
      wave: options.wave,
      shardIndex,
      shardCount: DISCOVERY_SHARD_COUNT,
      targetCounts,
      excludedSourcePrs: options.excludedSourcePrs,
    } satisfies DiscoveryShardInput);
    progress.complete(result.candidates.length);
    return result;
  } catch (error) {
    if (isCancellation(error) || !isExhaustedActivityFailure(error)) {
      throw error;
    }
    progress.fail();
    return { candidates: [] };
  }
}

function uniqueCandidates(candidates: readonly Candidate[]): Candidate[] {
  const seenPrs = new Set<number>();
  return candidates.filter((candidate) => {
    if (seenPrs.has(candidate.sourcePr)) {
      return false;
    }
    seenPrs.add(candidate.sourcePr);
    return true;
  });
}

export function selectCandidates(
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

export function missingCandidateCounts(
  selected: readonly Pick<Candidate, "difficulty">[],
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

export function candidatePoolExhausted(
  selected: readonly Candidate[],
  requested: RunRequest["candidateCounts"],
): ApplicationFailure {
  const missing = missingCandidateCounts(selected, requested);
  return ApplicationFailure.nonRetryable(
    `candidate pool exhausted; missing easy=${missing.easy}, medium=${missing.medium}, hard=${missing.hard}`,
    "CandidatePoolExhausted",
  );
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
