import type { Difficulty } from "../../contracts/index.js";
import { patchPaths } from "../../lib/patch-paths.js";

export interface PatchAudit {
  /** The hardest tier, up to the assigned one, that the gold patch reaches. */
  readonly difficulty: Difficulty;
  readonly blockers: readonly string[];
}

/** Each tier's least gold patch, easiest first. */
const difficultyThresholds: Record<
  Difficulty,
  { readonly implementationFiles: number; readonly changedLines: number }
> = {
  easy: { implementationFiles: 1, changedLines: 20 },
  medium: { implementationFiles: 2, changedLines: 50 },
  hard: { implementationFiles: 3, changedLines: 100 },
};

/** Each tier's least gold patch, as an author's brief states it. */
export function authoringTiers(): string {
  return Object.entries(difficultyThresholds)
    .map(
      ([tier, t]) =>
        `${tier}: ≥${t.changedLines} changed implementation lines across ≥${t.implementationFiles} file${t.implementationFiles === 1 ? "" : "s"}`,
    )
    .join("; ");
}

/** Each tier's least gold patch, as discovery prompts state it. */
export function tierSummary(): string {
  return Object.entries(difficultyThresholds)
    .map(([tier, t]) => `${tier} ≥${t.changedLines} lines across ≥${t.implementationFiles} files`)
    .join(", ");
}

/** The least gold patch any task takes, as a brief states it. */
export function easyFloor(): string {
  const { changedLines, implementationFiles } = difficultyThresholds.easy;
  return `${changedLines} changed implementation lines across ${implementationFiles} file`;
}

/**
 * A feature's: its tier is its PR count, so the assigned tier stands, but its reference must
 * still reach easy's size.
 */
export function auditFeaturePatches(
  goldPatch: string,
  testPatch: string,
  assigned: Difficulty,
): PatchAudit {
  const blockers = overlapBlockers(goldPatch, testPatch);
  const below = floorBlocker(patchMetrics(goldPatch));
  return { difficulty: assigned, blockers: below ? [...blockers, below] : blockers };
}

function floorBlocker(gold: { readonly files: number; readonly lines: number }) {
  const { implementationFiles, changedLines } = difficultyThresholds.easy;
  if (gold.files >= implementationFiles && gold.lines >= changedLines) return undefined;
  return `gold.patch changes ${gold.lines} lines across ${gold.files} files; even easy needs at least ${changedLines} across ${implementationFiles}`;
}

/**
 * Whether the patches make a benchmark: the hidden tests and the reference solution share no
 * file, and the solution is large enough for a tier. A task is never harder than assigned.
 */
export function auditPatches(
  goldPatch: string,
  testPatch: string,
  assigned: Difficulty,
): PatchAudit {
  const gold = patchMetrics(goldPatch);
  const blockers = overlapBlockers(goldPatch, testPatch);
  const tiers = Object.keys(difficultyThresholds) as Difficulty[];
  const reached = tiers
    .slice(0, tiers.indexOf(assigned) + 1)
    .reverse()
    .find((tier) => {
      const threshold = difficultyThresholds[tier];
      return gold.files >= threshold.implementationFiles && gold.lines >= threshold.changedLines;
    });
  const below = floorBlocker(gold);
  if (below) blockers.push(below);
  return { difficulty: reached ?? "easy", blockers };
}

/**
 * A scenario's: the hidden tests and the reference outcome share no file. Its gold patch is the
 * outcome a correct agent leaves (an answer file, an edited calendar), whose size says nothing
 * about how hard the scenario is, so the requester's tier stands.
 */
export function auditScenarioPatches(
  goldPatch: string,
  testPatch: string,
  assigned: Difficulty,
): PatchAudit {
  return { difficulty: assigned, blockers: overlapBlockers(goldPatch, testPatch) };
}

function overlapBlockers(goldPatch: string, testPatch: string): string[] {
  const tests = new Set(patchPaths(testPatch));
  const overlap = patchPaths(goldPatch).filter((path) => tests.has(path));
  return overlap.length > 0 ? [`gold.patch and test.patch both change ${overlap.join(", ")}`] : [];
}

/** How many files a patch changes, and its added and removed lines. */
function patchMetrics(patch: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    )
      lines += 1;
  }
  return { files, lines };
}
