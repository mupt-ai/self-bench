import type { Client } from "@temporalio/client";
import type { RunPhase, RunStatus } from "../contracts.js";
import { statusQuery } from "../temporal/workflow.js";

export async function queryStatus(
  handle: ReturnType<Client["workflow"]["getHandle"]>,
): Promise<RunStatus | object> {
  try {
    const [status, description] = await Promise.all([handle.query(statusQuery), handle.describe()]);
    if (description.status.name === "RUNNING" || terminalRunPhase(status.phase)) return status;
    const phase = executionPhase(description.status.name);
    return {
      ...status,
      phase,
      ...(phase === "failed" && !status.error
        ? { error: `Temporal workflow ${description.status.name.toLowerCase()}` }
        : {}),
    };
  } catch {
    const description = await handle.describe();
    return { runId: description.workflowId, phase: executionPhase(description.status.name) };
  }
}

function terminalRunPhase(phase: RunPhase): boolean {
  return ["complete", "blocked", "failed", "cancelled"].includes(phase);
}

function executionPhase(status: string): RunPhase {
  switch (status) {
    case "COMPLETED":
      return "complete";
    case "CANCELED":
      return "cancelled";
    case "RUNNING":
      return "queued";
    default:
      return "failed";
  }
}
