import { RetryState } from "@temporalio/common";
import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";

export function isExhaustedActivityFailure(error: unknown): error is ActivityFailure {
  return (
    error instanceof ActivityFailure && error.retryState === RetryState.MAXIMUM_ATTEMPTS_REACHED
  );
}

export function infrastructureFailureMessage(error: unknown): string {
  let cause = error;
  let message = error instanceof Error ? error.message : String(error);
  while (cause instanceof Error) {
    if (cause instanceof ApplicationFailure && cause.type === "HarborInfrastructureFailure") {
      return cause.message;
    }
    message = cause.message;
    cause = cause.cause;
  }
  return message;
}

export function isHarborInfrastructureFailure(error: unknown): boolean {
  let cause = error;
  while (cause instanceof Error) {
    if (cause instanceof ApplicationFailure && cause.type === "HarborInfrastructureFailure") {
      return true;
    }
    cause = cause.cause;
  }
  return false;
}
