import type { Difficulty } from "../../contracts/index.js";
import { patchPaths } from "../../lib/patch-paths.js";

export interface PatchAudit {
  /** The hardest tier, up to the assigned one, that the gold patch reaches. */
  readonly difficulty: Difficulty;
  readonly blockers: readonly string[];
}

/** Each tier's least gold patch, easiest first. */
export const difficultyThresholds: Record<
  Difficulty,
  { readonly implementationFiles: number; readonly changedLines: number }
> = {
  easy: { implementationFiles: 1, changedLines: 20 },
  medium: { implementationFiles: 2, changedLines: 50 },
  hard: { implementationFiles: 3, changedLines: 100 },
};

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
  const tests = new Set(patchPaths(testPatch));
  const blockers: string[] = [];
  const overlap = patchPaths(goldPatch).filter((path) => tests.has(path));
  if (overlap.length > 0) {
    blockers.push(`gold.patch and test.patch both change ${overlap.join(", ")}`);
  }
  const tiers = Object.keys(difficultyThresholds) as Difficulty[];
  const reached = tiers
    .slice(0, tiers.indexOf(assigned) + 1)
    .reverse()
    .find((tier) => {
      const threshold = difficultyThresholds[tier];
      return gold.files >= threshold.implementationFiles && gold.lines >= threshold.changedLines;
    });
  if (!reached) {
    const { implementationFiles, changedLines } = difficultyThresholds.easy;
    blockers.push(
      `gold.patch changes ${gold.lines} lines across ${gold.files} files; even easy needs at least ${changedLines} across ${implementationFiles}`,
    );
  }
  return { difficulty: reached ?? "easy", blockers };
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
