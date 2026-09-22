import { patched } from "@temporalio/workflow";
import type { ArtifactRef, AuthoredTask, Candidate } from "../../contracts.js";
import { rejected, type StageContext, type StageOutcome } from "./stage.js";

/** A fresh, read-only review of one mechanically green authoring revision. */
function renamedReviewActivityEnabled(): boolean {
  try {
    return patched("review-activity-rename-v1");
  } catch (error) {
    // The workflow unit tests call stage functions directly, outside a Temporal execution.
    if (
      error instanceof Error &&
      error.message.includes("may only be used from a Workflow Execution")
    ) {
      return true;
    }
    throw error;
  }
}

export async function reviewAuthoredTask(
  context: StageContext,
  candidate: Candidate,
  green: { readonly task: AuthoredTask; readonly report: ArtifactRef },
  round: number,
): Promise<StageOutcome | { kind: "suggestions"; feedback: string }> {
  context.update({ status: "reviewing", stage: "review", round });
  // Keep the old activity name available while in-flight histories drain. Temporal replays
  // the branch selected by this patch and therefore preserves the recorded activity type.
  const reviewRound = renamedReviewActivityEnabled()
    ? context.activitySet.runReviewRound
    : context.activitySet.runVerifierRound;
  if (!reviewRound) throw new Error("legacy review activity is not registered");
  const verdict = await reviewRound({
    run: context.run,
    candidate,
    ...green,
    round,
  });
  if (verdict.kind === "accepted") return { kind: "green", ...green };
  if (verdict.kind === "rejected") return rejected(verdict.reason);
  return { kind: "suggestions", feedback: `${verdict.summary}\n\n${verdict.suggestions}` };
}
