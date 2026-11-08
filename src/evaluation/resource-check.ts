import type { CredentialInfo } from "../db/credentials.js";
import { checkResources, resourceRefusal } from "../sandbox/resources.js";
import type { EvaluationInput } from "./types.js";

/**
 * Checks what each task asks for against the sandbox credential's per-sandbox limits before a
 * comparison is saved. A task over a limit refuses the whole comparison, naming each such task;
 * warnings (rounding, little headroom) are returned for the requester to see.
 */
export function assertTasksFitSandbox(
  tasks: EvaluationInput["tasks"],
  sandbox: { kind: string; resourceLimits?: CredentialInfo["resourceLimits"] },
): string[] {
  const checks = tasks.map((task) => ({
    task: task.taskId,
    ...checkResources(task.resources ?? {}, sandbox.resourceLimits, sandbox.kind),
  }));
  const refusal = resourceRefusal(checks);
  if (refusal) throw new Error(refusal);
  return [
    ...new Set(checks.flatMap((check) => check.warnings.map((line) => `${check.task} ${line}`))),
  ].slice(0, 20);
}
