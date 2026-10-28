import { ApplicationFailure } from "@temporalio/common";

/**
 * A trial setup failure that every attempt would meet again (a missing or oversized bundle, an
 * unusable credential, an unsupported Harbor): the trial fails at once instead of retrying.
 */
export function refuseTrial(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, "TrialRefused");
}
