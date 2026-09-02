import { isCancellation } from "@temporalio/workflow";
import type { AuthoredTask, Candidate, RunRequest, TaskProgress } from "../../contracts.js";
import type { SelfBenchActivities } from "../activities.js";
import { authorWithVerification } from "./authoring-stage.js";
import {
  infrastructureFailureMessage,
  isExhaustedActivityFailure,
  isHarborInfrastructureFailure,
} from "./failures.js";
import type { StageContext, StageOutcome } from "./stage.js";
import { verifyWithCleanup } from "./verification-stage.js";

interface CandidateProcessorOptions {
  readonly activitySet: SelfBenchActivities;
  readonly run: RunRequest;
  readonly taskProgress: TaskProgress[];
  readonly acceptedTasks: AuthoredTask[];
  readonly taskIds: Map<string, string>;
  readonly setTasks: (tasks: readonly TaskProgress[]) => void;
}

/**
 * Runs one candidate through the authoring loop (agent + mechanical verification, ≤3 rounds) and
 * then the independent verification loop (fresh agent, ≤3 rounds). Only exhausted or Harbor
 * infrastructure failures are absorbed per candidate; everything else propagates.
 */
export function createCandidateProcessor(
  options: CandidateProcessorOptions,
): (candidate: Candidate) => Promise<void> {
  const { activitySet, run, taskProgress, acceptedTasks, taskIds, setTasks } = options;
  return async (candidate: Candidate): Promise<void> => {
    const progress: TaskProgress = {
      candidateId: candidate.candidateId,
      taskId: candidate.candidateId,
      difficulty: candidate.difficulty,
      status: "authoring",
      stage: "authoring",
      round: 1,
    };
    taskProgress.push(progress);
    setTasks(taskProgress);
    const context: StageContext = {
      activitySet,
      run,
      taskIds,
      update: (patch) => {
        Object.assign(progress, patch);
        setTasks(taskProgress);
      },
    };
    const finish = (outcome: StageOutcome): void => {
      if (outcome.kind === "green") {
        progress.status = "accepted";
        acceptedTasks.push(outcome.task);
      } else {
        progress.status = outcome.kind;
        progress.reason = outcome.reason;
      }
      setTasks(taskProgress);
    };
    try {
      const authored = await authorWithVerification(context, candidate);
      if (authored.kind !== "green") {
        finish(authored);
        return;
      }
      finish(await verifyWithCleanup(context, candidate, authored));
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      if (!isExhaustedActivityFailure(error) && !isHarborInfrastructureFailure(error)) {
        throw error;
      }
      progress.status = "infrastructure_failed";
      progress.reason = infrastructureFailureMessage(error);
      setTasks(taskProgress);
    }
  };
}
