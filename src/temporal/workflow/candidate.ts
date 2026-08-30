import { isCancellation } from "@temporalio/workflow";
import type {
  AuthoredTask,
  AuthorOutcome,
  Candidate,
  RunRequest,
  TaskProgress,
} from "../../contracts.js";
import type {
  AuthorCandidateInput,
  EnvironmentAuthoringInput,
  RepairTaskInput,
  SelfBenchActivities,
  TaskStageInput,
  ValidationRepairTaskInput,
} from "../activities.js";
import {
  infrastructureFailureMessage,
  isExhaustedActivityFailure,
  isHarborInfrastructureFailure,
} from "./failures.js";

interface CandidateProcessorOptions {
  readonly activitySet: SelfBenchActivities;
  readonly run: RunRequest;
  readonly taskProgress: TaskProgress[];
  readonly acceptedTasks: AuthoredTask[];
  readonly taskIds: Set<string>;
  readonly setTasks: (tasks: readonly TaskProgress[]) => void;
}

export function createCandidateProcessor(
  options: CandidateProcessorOptions,
): (candidate: Candidate) => Promise<void> {
  const { activitySet, run, taskProgress, acceptedTasks, taskIds, setTasks } = options;
  const rejectProgress = (progress: TaskProgress, reason: string): void => {
    progress.status = "rejected";
    progress.reason = reason;
    setTasks(taskProgress);
  };
  const processCandidate = async (candidate: Candidate): Promise<void> => {
    const progress: TaskProgress = {
      candidateId: candidate.candidateId,
      taskId: candidate.candidateId,
      difficulty: candidate.difficulty,
      status: "task_authoring",
    };
    taskProgress.push(progress);
    setTasks(taskProgress);
    try {
      const authored = await activitySet.authorCandidate({
        run,
        candidate,
      } satisfies AuthorCandidateInput);
      if (authored.kind === "rejected") {
        rejectProgress(progress, authored.reason);
        return;
      }
      const taskDraft = authored.task;
      if (taskIds.has(taskDraft.taskId)) {
        rejectProgress(progress, `authoring repeated task ID ${taskDraft.taskId}`);
        return;
      }
      taskIds.add(taskDraft.taskId);
      progress.taskId = taskDraft.taskId;

      progress.status = "environment_authoring";
      setTasks(taskProgress);
      const environment = await activitySet.authorEnvironment({
        run,
        task: taskDraft,
      } satisfies EnvironmentAuthoringInput);
      if (environment.kind === "rejected") {
        rejectProgress(progress, environment.reason);
        return;
      }
      let task = environment.task;

      progress.status = "auditing";
      setTasks(taskProgress);
      const audit = await activitySet.auditTask({ run, task } satisfies TaskStageInput);
      if (!audit.accepted) {
        rejectProgress(progress, audit.reason ?? "audit rejected task");
        return;
      }

      let preflightAccepted = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        progress.status = "preflighting";
        setTasks(taskProgress);
        const preflight = await activitySet.preflightEnvironment({
          run,
          task,
        } satisfies TaskStageInput);
        if (preflight.accepted) {
          preflightAccepted = true;
          break;
        }
        if (attempt === 2) {
          rejectProgress(
            progress,
            preflight.reason ?? "environment preflight failed after two repairs",
          );
          return;
        }
        progress.status = "environment_repairing";
        setTasks(taskProgress);
        const repairedEnvironment = await activitySet.authorEnvironment({
          run,
          task: taskDraft,
          previousTask: task,
          diagnostics: preflight.reason ?? "environment preflight failed without diagnostics",
        } satisfies EnvironmentAuthoringInput);
        if (repairedEnvironment.kind === "rejected") {
          rejectProgress(progress, repairedEnvironment.reason);
          return;
        }
        task = repairedEnvironment.task;
      }
      if (!preflightAccepted) {
        rejectProgress(progress, "environment preflight did not complete");
        return;
      }

      progress.status = "validating";
      setTasks(taskProgress);
      let validation = await activitySet.validateTask({
        run,
        task,
      } satisfies TaskStageInput);
      if (!validation.accepted) {
        progress.status = "repairing";
        setTasks(taskProgress);
        let repaired: AuthorOutcome;
        try {
          repaired = await activitySet.repairValidationTask({
            run,
            task,
            validation,
          } satisfies ValidationRepairTaskInput);
        } catch (error) {
          if (isCancellation(error) || !isExhaustedActivityFailure(error)) {
            throw error;
          }
          rejectProgress(progress, "validation repair failed after its single activity attempt");
          return;
        }
        if (repaired.kind === "rejected") {
          rejectProgress(progress, repaired.reason);
          return;
        }
        task = repaired.task;

        progress.status = "auditing";
        setTasks(taskProgress);
        const repairAudit = await activitySet.auditTask({
          run,
          task,
        } satisfies TaskStageInput);
        if (!repairAudit.accepted) {
          rejectProgress(progress, repairAudit.reason ?? "audit rejected validation repair");
          return;
        }

        progress.status = "validating";
        setTasks(taskProgress);
        validation = await activitySet.validateTask({
          run,
          task,
        } satisfies TaskStageInput);
        if (!validation.accepted) {
          rejectProgress(progress, validation.reason ?? "validation rejected repaired harness");
          return;
        }
      }

      progress.status = "reviewing";
      setTasks(taskProgress);
      let review = await activitySet.reviewTask({ run, task } satisfies TaskStageInput);
      if (!review.accepted) {
        progress.status = "repairing";
        setTasks(taskProgress);
        let repaired: AuthorOutcome;
        try {
          repaired = await activitySet.repairTask({
            run,
            task,
            review: review.report,
          } satisfies RepairTaskInput);
        } catch (error) {
          if (isCancellation(error) || !isExhaustedActivityFailure(error)) {
            throw error;
          }
          rejectProgress(progress, "test repair failed after activity retries");
          return;
        }
        if (repaired.kind === "rejected") {
          rejectProgress(progress, repaired.reason);
          return;
        }
        task = repaired.task;

        progress.status = "auditing";
        setTasks(taskProgress);
        const repairAudit = await activitySet.auditTask({
          run,
          task,
        } satisfies TaskStageInput);
        if (!repairAudit.accepted) {
          rejectProgress(progress, repairAudit.reason ?? "audit rejected repaired task");
          return;
        }

        progress.status = "validating";
        setTasks(taskProgress);
        const repairValidation = await activitySet.validateTask({
          run,
          task,
        } satisfies TaskStageInput);
        if (!repairValidation.accepted) {
          rejectProgress(progress, repairValidation.reason ?? "validation rejected repaired task");
          return;
        }

        progress.status = "reviewing";
        setTasks(taskProgress);
        review = await activitySet.reviewTask({ run, task } satisfies TaskStageInput);
        if (!review.accepted) {
          rejectProgress(progress, review.reason ?? "review rejected repaired task");
          return;
        }
      }

      progress.status = "accepted";
      acceptedTasks.push(task);
      setTasks(taskProgress);
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
  return processCandidate;
}
