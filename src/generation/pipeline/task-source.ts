import type { Candidate } from "../../contracts/index.js";

/**
 * What the author's static check needs to know of the task's source (static-check.ts): the base
 * commit its patches apply to, and for a scenario which audit applies and where its snapshot is.
 */
export function taskSourceEnvironment(candidate: Candidate): Record<string, string> {
  if (candidate.kind !== "scenario") return { SELFBENCH_BASE_COMMIT: candidate.baseCommit };
  if (!candidate.baseCommit) return { SELFBENCH_TASK_SOURCE: "scenario" };
  return {
    SELFBENCH_TASK_SOURCE: "repository_scenario",
    SELFBENCH_BASE_COMMIT: candidate.baseCommit,
  };
}
