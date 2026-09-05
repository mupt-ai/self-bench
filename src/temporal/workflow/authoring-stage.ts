import { type ArtifactRef, type Candidate, MAX_AUTHORING_ROUNDS } from "../../contracts.js";
import { verifyReportSummary } from "../../verify-report.js";
import { infrastructureCounter, rejected, type StageContext, type StageOutcome } from "./stage.js";
import { reviewAuthoredTask } from "./verification-stage.js";

/** Authors own revisions; fresh read-only reviewers return feedback, never modified tasks. */
export async function authorWithVerification(
  context: StageContext,
  candidate: Candidate,
): Promise<StageOutcome> {
  let session: ArtifactRef | undefined;
  let report: ArtifactRef | undefined;
  let feedback: string | undefined;
  let lastSummary = "no verification report";
  let verifyCallsUsed = 0;
  const infrastructure = infrastructureCounter();
  for (let round = 1; round <= MAX_AUTHORING_ROUNDS; round += 1) {
    context.update({ status: "authoring", stage: "authoring", round });
    const authored = await context.activitySet.runAuthoringRound({
      run: context.run,
      candidate,
      round,
      verifyCallsUsed,
      ...(session ? { session } : {}),
      ...(report ? { report } : {}),
      ...(feedback ? { feedback } : {}),
    });
    if (authored.kind === "rejected") return rejected(authored.reason);
    session = authored.session;
    verifyCallsUsed += authored.verifyCalls ?? 0;
    context.update({ taskId: authored.task.taskId, status: "verifying" });
    let green = authored.verified;
    if (!green) {
      const outcome = await context.activitySet.compileAndVerify({
        run: context.run,
        candidate,
        task: authored.task,
        stage: "authoring",
        round,
      });
      report = outcome.reportRef;
      lastSummary = verifyReportSummary(outcome.report);
      if (infrastructure.observe(outcome.report.build.infrastructure)) {
        return {
          kind: "infrastructure_failed",
          reason: `Harbor infrastructure failed in ${round} consecutive authoring rounds: ${outcome.report.build.logTail.slice(0, 500)}`,
        };
      }
      if (outcome.report.green && outcome.task) green = { task: outcome.task, report };
    } else infrastructure.observe(false);
    if (!green) continue;
    report = green.report;
    const review = await reviewAuthoredTask(context, candidate, green, round);
    if (review.kind !== "suggestions") return review;
    feedback = review.feedback;
    lastSummary = `verifier requested authoring changes: ${feedback}`;
  }
  return rejected(`authoring exhausted ${MAX_AUTHORING_ROUNDS} rounds; ${lastSummary}`);
}
