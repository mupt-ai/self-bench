import type { Difficulty } from "./common.js";

/**
 * A feature's tier is how many merged PRs built it, not the size of its reference: a feature is
 * hard because it spans many changes, which a line count measures poorly.
 */
export const FEATURE_TIER_PRS: Readonly<Record<Difficulty, string>> = {
  easy: "1–3 PRs",
  medium: "4–8 PRs",
  hard: "9+ PRs",
};

export function featureDifficulty(pullRequests: number): Difficulty {
  if (pullRequests <= 3) return "easy";
  if (pullRequests <= 8) return "medium";
  return "hard";
}

/** Each tier's PR count, as prompts state it. */
export function featureTierSummary(): string {
  return Object.entries(FEATURE_TIER_PRS)
    .map(([tier, prs]) => `${tier} ${prs}`)
    .join(", ");
}
