import { harborEnvironmentName, harborPythonPath } from "./harbor-environment.js";
import type { HarborEnvironment } from "./providers.js";

/** Process policy shared by generation gates and solver trials, not provider lifetimes. */
export const HARBOR_PROCESS_TIMEOUT_MS = {
  gate: 3 * 60 * 60 * 1000,
  solver: 2 * 60 * 60 * 1000,
} as const;

export interface HarborRunCommand {
  taskPath: string;
  jobsPath: string;
  jobName: string;
  environment: HarborEnvironment;
  agent: string;
  solver?: { model: string; agentArguments: readonly string[] };
  quiet?: boolean;
}

/** Arguments remain separate strings: task paths and model names are never shell interpolated. */
export function harborRunArguments(input: HarborRunCommand): string[] {
  return [
    "run",
    "--path",
    input.taskPath,
    "--agent",
    input.agent,
    ...(input.solver ? ["--model", input.solver.model] : []),
    "--env",
    harborEnvironmentName(input.environment),
    "--jobs-dir",
    input.jobsPath,
    "--job-name",
    input.jobName,
    ...(input.solver ? ["--n-attempts", "1", "--n-concurrent", "1", "--max-retries", "0"] : []),
    "--delete",
    "--yes",
    ...(input.quiet ? ["--quiet"] : []),
    ...(input.solver?.agentArguments ?? []),
  ];
}

/** Callers must first resolve their distinct generation/solver credential boundaries. */
export function harborProcessEnvironment(resolved: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...resolved, PYTHONPATH: harborPythonPath() };
}
