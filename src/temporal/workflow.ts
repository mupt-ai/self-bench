import { defineQuery, setHandler } from "@temporalio/workflow";
import type { RunResult, RunStatus, WorkflowRunInput } from "../contracts.js";
import { workflowActivities } from "./workflow/activity-proxies.js";
import { executeRun } from "./workflow/run.js";

export const statusQuery = defineQuery<RunStatus>("status");

export async function selfBenchRunWorkflow(input: WorkflowRunInput): Promise<RunResult> {
  return await executeRun(input, workflowActivities, (status) =>
    setHandler(statusQuery, () => status()),
  );
}

export { executeRun } from "./workflow/run.js";
