import { isCancellation } from "@temporalio/workflow";
import type {
  Candidate,
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  TaskProgress,
} from "../../contracts.js";
import type { SelfBenchActivities } from "../activities.js";
import { authorWithVerification } from "./authoring-stage.js";
import {
  infrastructureFailureMessage,
  isExhaustedActivityFailure,
  isHarborInfrastructureFailure,
} from "./failures.js";
import type { StageContext } from "./stage.js";
import { verifyWithCleanup } from "./verification-stage.js";

export function initialProgress(candidate: Candidate): TaskProgress {
  return {
    candidateId: candidate.candidateId,
    taskId: candidate.candidateId,
    difficulty: candidate.difficulty,
    status: "authoring",
    stage: "authoring",
    round: 1,
  };
}

/**
 * Body of one candidate child workflow: the authoring loop (agent + mechanical verification, ≤3
 * rounds) and then the independent verification loop (fresh agent, ≤3 rounds). `report` fires with
 * a snapshot on every progress change; the returned result is authoritative. Only exhausted or
 * Harbor infrastructure failures are absorbed; everything else propagates and fails the child.
 */
export async function executeCandidate(
  input: CandidateWorkflowInput,
  activitySet: SelfBenchActivities,
  report: (progress: TaskProgress) => void,
): Promise<CandidateWorkflowResult> {
  const { run, candidate } = input;
  const progress = initialProgress(candidate);
  const publish = (): TaskProgress => {
    const snapshot = { ...progress };
    report(snapshot);
    return snapshot;
  };
  publish();
  const context: StageContext = {
    activitySet,
    run,
    update: (patch) => {
      Object.assign(progress, patch);
      publish();
    },
  };
  try {
    const authored = await authorWithVerification(context, candidate);
    const outcome =
      authored.kind === "green" ? await verifyWithCleanup(context, candidate, authored) : authored;
    if (outcome.kind === "green") {
      progress.status = "accepted";
      return { progress: publish(), task: outcome.task, report: outcome.report };
    }
    progress.status = outcome.kind;
    progress.reason = outcome.reason;
    return { progress: publish() };
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    if (!isExhaustedActivityFailure(error) && !isHarborInfrastructureFailure(error)) {
      throw error;
    }
    progress.status = "infrastructure_failed";
    progress.reason = infrastructureFailureMessage(error);
    return { progress: publish() };
  }
}
