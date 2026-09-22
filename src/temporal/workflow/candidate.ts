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

/** Up to three authoring revisions, each gated mechanically and reviewed read-only. */
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
    const outcome = await authorWithVerification(context, candidate);
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
