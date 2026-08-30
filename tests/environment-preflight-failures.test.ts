import { describe, expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { isRethrownEnvironmentPreflightFailure } from "../src/temporal/activities/environment.js";

describe("environment preflight failure classification", () => {
  test("rethrows typed Harbor infrastructure failures for Temporal retries", () => {
    const error = ApplicationFailure.retryable(
      "Harbor nop exited 1 for task: image build for im-abc123 failed",
      "HarborInfrastructureFailure",
    );
    expect(isRethrownEnvironmentPreflightFailure(error)).toBe(true);
  });

  test("rethrows infrastructure failures nested under an activity error", () => {
    const error = new Error("Activity task failed", {
      cause: ApplicationFailure.retryable(
        "Harbor nop infrastructure failure for task: cannot connect to the docker daemon",
        "HarborInfrastructureFailure",
      ),
    });
    expect(isRethrownEnvironmentPreflightFailure(error)).toBe(true);
  });

  test("rethrows Temporal cancellation", () => {
    expect(isRethrownEnvironmentPreflightFailure(new CancelledFailure("canceled"))).toBe(true);
  });

  test("does not rethrow repairable environment defects", () => {
    expect(
      isRethrownEnvironmentPreflightFailure(
        new Error("harbor run failed: Dockerfile did not complete successfully"),
      ),
    ).toBe(false);
    expect(isRethrownEnvironmentPreflightFailure(new Error("service db was unhealthy"))).toBe(
      false,
    );
  });

  test("does not rethrow untyped ApplicationFailures", () => {
    expect(
      isRethrownEnvironmentPreflightFailure(ApplicationFailure.nonRetryable("Dockerfile missing")),
    ).toBe(false);
  });
});
