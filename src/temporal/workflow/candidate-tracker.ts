import { isCancellation } from "@temporalio/workflow";
import type {
  AuthoredTask,
  Candidate,
  CandidateWorkflowResult,
  RunRequest,
  TaskProgress,
} from "../../contracts.js";
import type { SelfBenchActivities } from "../activities.js";
import { executeCandidate, initialProgress } from "./candidate.js";
import { infrastructureFailureMessage } from "./failures.js";

/**
 * How the run workflow reaches its candidate children. The Temporal workflow binds these to
 * `executeChild` and the progress signal; tests run candidates in-process.
 */
export interface CandidateChildren {
  /** Registers the handler that receives every progress update a child reports. */
  readonly installProgressSignal: (handler: (progress: TaskProgress) => void) => void;
  /** Starts one candidate child and resolves with its authoritative result. */
  readonly startCandidate: (
    run: RunRequest,
    candidate: Candidate,
  ) => Promise<CandidateWorkflowResult>;
}

/** Runs candidates in the caller's process, forwarding progress to the installed handler. */
export function inProcessCandidates(activitySet: SelfBenchActivities): CandidateChildren {
  let handler: (progress: TaskProgress) => void = () => undefined;
  return {
    installProgressSignal: (next) => {
      handler = next;
    },
    startCandidate: (run, candidate) =>
      executeCandidate({ run, candidate }, activitySet, (progress) => handler(progress)),
  };
}

export interface CandidateTracker {
  /** Live per-candidate progress in first-seen order; the same array the status query exposes. */
  readonly taskProgress: readonly TaskProgress[];
  readonly acceptedTasks: readonly AuthoredTask[];
  /** Starts one candidate and records its authoritative outcome. */
  readonly process: (run: RunRequest, candidate: Candidate) => Promise<void>;
}

/**
 * Parent-side bookkeeping for candidate children: applies progress signals, applies each child's
 * final result (authoritative even if a signal was lost), keeps task IDs unique across candidates,
 * and turns a failed child into an infrastructure-failed candidate instead of a failed run.
 */
export function createCandidateTracker(
  children: CandidateChildren,
  setTasks: (tasks: readonly TaskProgress[]) => void,
): CandidateTracker {
  const taskProgress: TaskProgress[] = [];
  const acceptedTasks: AuthoredTask[] = [];
  const settled = new Set<string>();
  /** taskId → owning candidateId, so two candidates never export the same task. */
  const taskIds = new Map<string, string>();

  const record = (progress: TaskProgress): void => {
    const index = taskProgress.findIndex((task) => task.candidateId === progress.candidateId);
    if (index === -1) {
      taskProgress.push(progress);
    } else {
      taskProgress[index] = progress;
    }
    setTasks(taskProgress);
  };
  const applyProgress = (progress: TaskProgress): void => {
    if (!settled.has(progress.candidateId)) {
      record(progress);
    }
  };
  const settle = (candidate: Candidate, result: CandidateWorkflowResult): void => {
    settled.add(candidate.candidateId);
    if (!result.task) {
      record(result.progress);
      return;
    }
    const owner = taskIds.get(result.task.taskId);
    if (owner !== undefined && owner !== candidate.candidateId) {
      record({
        ...result.progress,
        status: "rejected",
        reason: `authoring repeated task ID ${result.task.taskId} already claimed by ${owner}`,
      });
      return;
    }
    taskIds.set(result.task.taskId, candidate.candidateId);
    acceptedTasks.push(result.task);
    record(result.progress);
  };

  children.installProgressSignal(applyProgress);
  return {
    taskProgress,
    acceptedTasks,
    process: async (run, candidate) => {
      applyProgress(initialProgress(candidate));
      try {
        settle(candidate, await children.startCandidate(run, candidate));
      } catch (error) {
        if (isCancellation(error)) {
          throw error;
        }
        const current =
          taskProgress.find((task) => task.candidateId === candidate.candidateId) ??
          initialProgress(candidate);
        settle(candidate, {
          progress: {
            ...current,
            status: "infrastructure_failed",
            reason: infrastructureFailureMessage(error),
          },
        });
      }
    },
  };
}
