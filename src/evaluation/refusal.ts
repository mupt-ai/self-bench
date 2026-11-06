import { ApplicationFailure } from "@temporalio/common";

/**
 * A trial setup failure that every attempt would meet again (a missing or oversized bundle, an
 * unusable credential, an unsupported Harbor): the trial fails at once instead of retrying.
 */
export function refuseTrial(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, "TrialRefused");
}

/** Why a task's images could not be readied: its trials fail with it, before any spends. */
export const TASK_IMAGES_FAILED = "TaskImagesFailed";

export function taskImagesFailed(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, TASK_IMAGES_FAILED);
}
