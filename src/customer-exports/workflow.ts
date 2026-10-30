import { CancellationScope, proxyActivities } from "@temporalio/workflow";
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
  } catch {
    await CancellationScope.nonCancellable(() => failures.failCustomerExport(request));
  }
}
