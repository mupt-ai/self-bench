import { isRecord } from "../../lib/util.js";

/** What a Harbor trial raised, as `Type: message`. */
export function trialError(trial: unknown): string | undefined {
  const info = isRecord(trial) ? trial.exception_info : undefined;
  if (info === undefined || info === null) return undefined;
  if (!isRecord(info)) return JSON.stringify(info);
  const type = typeof info.exception_type === "string" ? `${info.exception_type}: ` : "";
  return `${type}${String(info.exception_message ?? "")}`;
}

/** Whether the trial got as far as running its agent. */
export function agentStarted(trial: unknown): boolean {
  const execution = isRecord(trial) ? trial.agent_execution : undefined;
  return isRecord(execution) && execution.started_at != null;
}

/** The verifier's raw rewards. */
export function rewards(trial: unknown): Record<string, unknown> {
  const result = isRecord(trial) ? trial.verifier_result : undefined;
  return isRecord(result) && isRecord(result.rewards) ? result.rewards : {};
}
