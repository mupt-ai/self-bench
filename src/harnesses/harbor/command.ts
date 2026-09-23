import { fileURLToPath } from "node:url";
import type { HarborEnvironment } from "../../contracts/config/providers.js";

/** Process policy shared by generation gates and solver trials, not provider lifetimes. */
export const HARBOR_VERSION = "0.23.0";

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
  /** Provider hosts merged into Harbor's agent network allowlist for this trial. */
  extraAllowedHosts?: readonly string[];
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
    input.environment,
    "--jobs-dir",
    input.jobsPath,
    "--job-name",
    input.jobName,
    "--n-attempts",
    "1",
    "--n-concurrent",
    "1",
    "--max-retries",
    "0",
    "--delete",
    "--yes",
    ...(input.quiet ? ["--quiet"] : []),
    ...(input.extraAllowedHosts ?? []).flatMap((host) => ["--allow-agent-host", host]),
    ...(input.solver?.agentArguments ?? []),
  ];
}

/** Callers must first resolve their distinct generation/solver credential boundaries. */
export function assertHarborVersion(actual: string): void {
  if (actual.trim() !== HARBOR_VERSION) {
    throw new Error(
      `Harbor version ${actual.trim() || "unknown"} does not match supported ${HARBOR_VERSION}`,
    );
  }
}

export function harborProcessEnvironment(resolved: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...resolved, PYTHONPATH: harborPythonPath() };
}

/** Harbor imports SelfBench's agent adapters (runtime/*.py) from here. */
export function harborPythonPath(): string {
  return fileURLToPath(new URL("./runtime/", import.meta.url));
}
