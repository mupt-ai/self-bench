import { type FeatureCandidate, featureTierSummary } from "../../contracts/index.js";
import { easyFloor } from "../task/audit.js";
import { renderPrompt } from "./prompts.js";

/**
 * A feature's brief: its PRs in merge order with the commits they landed as, which the author
 * replays onto the base for the reference, and the end-to-end tests it writes for the feature.
 */
export function featureAuthoringPrompt(
  candidate: FeatureCandidate,
  shared: {
    readonly howToWork: string;
    readonly feedback: string;
    readonly limits: string;
    readonly maintainer: string;
  },
): string {
  return renderPrompt("feature-authoring", {
    ...shared,
    tiers: featureTierSummary(),
    floor: easyFloor(),
    title: candidate.title,
    baseCommit: candidate.baseCommit,
    completedCommit: candidate.completedCommit,
    difficulty: candidate.difficulty,
    pullRequests: candidate.pullRequests
      .map((pr) => `- #${pr.number} ${pr.title} (${pr.url}), landed as ${pr.mergeCommit}`)
      .join("\n"),
    request: candidate.request,
  });
}
