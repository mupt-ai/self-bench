import type { ArtifactRef, AuthoredTask, Candidate } from "../../contracts.js";
import { rejected, type StageContext, type StageOutcome } from "./stage.js";

/** A fresh, read-only review of one mechanically green authoring revision. */
export async function reviewAuthoredTask(
  context: StageContext,
  candidate: Candidate,
  green: { readonly task: AuthoredTask; readonly report: ArtifactRef },
  round: number,
): Promise<StageOutcome | { kind: "suggestions"; feedback: string }> {
  context.update({ status: "reviewing", stage: "verification", round });
  const verdict = await context.activitySet.runVerifierRound({
    run: context.run,
    candidate,
    ...green,
    round,
  });
  if (verdict.kind === "accepted") return { kind: "green", ...green };
  if (verdict.kind === "rejected") return rejected(verdict.reason);
  if (verdict.kind === "suggestions") {
    return { kind: "suggestions", feedback: `${verdict.summary}\n\n${verdict.suggestions}` };
  }
  throw new Error("Read-only verifier returned a legacy fix instead of suggestions");
}
