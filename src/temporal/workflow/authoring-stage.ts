import { type ArtifactRef, type Candidate, MAX_AUTHORING_ROUNDS } from "../../contracts.js";
import { verifyReportSummary } from "../../verify-report.js";
import type { AuthoringRoundInput, CompileAndVerifyInput } from "../activities.js";
import {
  claimTaskId,
  infrastructureCounter,
  rejected,
  type StageContext,
  type StageOutcome,
} from "./stage.js";

/**
 * Stage 2: one authoring session per candidate, resumed with the verification report until the
 * trusted compile, audit, build, smoke, nop, and oracle gates are all green or the rounds run out.
 */
export async function authorWithVerification(
  context: StageContext,
  candidate: Candidate,
): Promise<StageOutcome> {
  const { activitySet, run } = context;
  let session: ArtifactRef | undefined;
  let report: ArtifactRef | undefined;
  let lastSummary = "no verification report";
  const infrastructure = infrastructureCounter();
  for (let round = 1; round <= MAX_AUTHORING_ROUNDS; round += 1) {
    context.update({ status: "authoring", stage: "authoring", round });
    const authored = await activitySet.runAuthoringRound({
      run,
      candidate,
      round,
      ...(session ? { session } : {}),
      ...(report ? { report } : {}),
    } satisfies AuthoringRoundInput);
    if (authored.kind === "rejected") {
      return rejected(authored.reason);
    }
    session = authored.session;
    const collision = claimTaskId(context, candidate, authored.task.taskId);
    if (collision) {
      return rejected(collision);
    }
    context.update({ taskId: authored.task.taskId, status: "verifying" });
    const outcome = await activitySet.compileAndVerify({
      run,
      candidate,
      task: authored.task,
      stage: "authoring",
      round,
    } satisfies CompileAndVerifyInput);
    report = outcome.reportRef;
    lastSummary = verifyReportSummary(outcome.report);
    if (outcome.report.green && outcome.task) {
      return { kind: "green", task: outcome.task, report: outcome.reportRef };
    }
    if (infrastructure.observe(outcome.report.build.infrastructure)) {
      return {
        kind: "infrastructure_failed",
        reason: `Harbor infrastructure failed in ${round} consecutive authoring rounds: ${outcome.report.build.logTail.slice(0, 500)}`,
      };
    }
  }
  return rejected(`authoring exhausted ${MAX_AUTHORING_ROUNDS} rounds; ${lastSummary}`);
}
