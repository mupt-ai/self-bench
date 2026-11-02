import { ActivityFailure, CancellationScope, proxyActivities } from "@temporalio/workflow";
import type { CustomerExportActivities } from "./activities.js";
import type { CustomerExportRequest } from "./types.js";

const activities = proxyActivities<CustomerExportActivities>({
  startToCloseTimeout: "3 hours",
  heartbeatTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});
const failures = proxyActivities<Pick<CustomerExportActivities, "failCustomerExport">>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});
export async function selfBenchCustomerExportWorkflow(
  request: CustomerExportRequest,
): Promise<void> {
  try {
    await activities.prepareCustomerExport(request);
  } catch (error) {
    // The last attempt's own message names the step that failed, such as an HTTP 403 on the registry.
    const reason =
      error instanceof ActivityFailure && error.cause ? error.cause.message : undefined;
    await CancellationScope.nonCancellable(() => failures.failCustomerExport(request, reason));
  }
}
