import {
  type ArtifactRef,
  type AuthoredTask,
  type Candidate,
  MAX_VERIFIER_ROUNDS,
} from "../../contracts.js";
import { verifyReportSummary } from "../../verify-report.js";
import type { CompileAndVerifyInput, VerifierRoundInput } from "../activities.js";
import { infrastructureCounter, rejected, type StageContext, type StageOutcome } from "./stage.js";

/**
 * Stage 3: a fresh verification agent that never saw the authoring conversation judges the green
 * task and either accepts it or fixes the held-out tests / environment contract. Every fix is
 * re-verified and the same verifier session is resumed with the new report.
 */
export async function verifyWithCleanup(
  context: StageContext,
  candidate: Candidate,
  green: { readonly task: AuthoredTask; readonly report: ArtifactRef },
): Promise<StageOutcome> {
  const { activitySet, run } = context;
  let task = green.task;
  let report = green.report;
  let reportGreen = true;
  let lastSummary = "all gates green";
  let session: ArtifactRef | undefined;
  let verifyCallsUsed = 0;
  const infrastructure = infrastructureCounter();
  for (let round = 1; round <= MAX_VERIFIER_ROUNDS; round += 1) {
    context.update({ status: "reviewing", stage: "verification", round });
    const verdict = await activitySet.runVerifierRound({
      run,
      candidate,
      task,
      report,
      round,
      verifyCallsUsed,
      ...(session ? { session } : {}),
    } satisfies VerifierRoundInput);
    if (verdict.kind === "rejected") {
      return rejected(verdict.reason);
    }
    session = verdict.session;
    if (verdict.kind === "accepted") {
      return reportGreen
        ? { kind: "green", task, report }
        : rejected(`verifier accepted while mechanical gates were red; ${lastSummary}`);
    }
    verifyCallsUsed += verdict.verifyCalls ?? 0;
    context.update({ status: "verifying" });
    if (verdict.verified) {
      task = verdict.verified.task;
      report = verdict.verified.report;
      reportGreen = true;
      lastSummary = "all gates green (verified in-session)";
      continue;
    }
    const outcome = await activitySet.compileAndVerify({
      run,
      candidate,
      task: verdict.task,
      stage: "verification",
      round,
    } satisfies CompileAndVerifyInput);
    report = outcome.reportRef;
    reportGreen = outcome.report.green;
    lastSummary = verifyReportSummary(outcome.report);
    if (outcome.task) {
      task = outcome.task;
    }
    if (infrastructure.observe(outcome.report.build.infrastructure)) {
      return {
        kind: "infrastructure_failed",
        reason: `Harbor infrastructure failed in ${round} consecutive verification rounds: ${outcome.report.build.logTail.slice(0, 500)}`,
      };
    }
  }
  return rejected(
    `verification exhausted ${MAX_VERIFIER_ROUNDS} rounds without acceptance; ${lastSummary}`,
  );
}
