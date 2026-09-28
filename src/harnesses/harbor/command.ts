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
  /** Harbor `--ek` settings for the environment, such as pinnedImageKwargs. */
  environmentKwargs?: Readonly<Record<string, string>>;
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
    harborEnvironmentArgument(input.environment),
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
    ...Object.entries(input.environmentKwargs ?? {}).flatMap(([key, value]) => [
      "--ek",
      `${key}=${value}`,
    ]),
    ...(input.solver?.agentArguments ?? []),
  ];
}

/**
 * Modal runs through SelfBench's subclass of Harbor's Modal environment (runtime/selfbench_modal.py),
 * which records the images a run built and starts trials from a task's pinned images. With no
 * pins it behaves exactly like `--env modal`; every other provider is Harbor's own.
 */
function harborEnvironmentArgument(environment: HarborEnvironment): string {
  return environment === "modal" ? "selfbench_modal:SelfBenchModalEnvironment" : environment;
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
  // Harbor prints its result tables with rich, which truncates columns to COLUMNS (80 without a
  // terminal); a wide width keeps every metric name and value whole in captured logs. Harbor's
  // job-finished telemetry imports litellm just to split model names, which takes a run's peak
  // from ~105 MiB to ~280 MiB, and it would report our jobs to Harbor's analytics.
  return {
    ...resolved,
    PYTHONPATH: harborPythonPath(),
    COLUMNS: "320",
    HARBOR_TELEMETRY: "off",
  };
}

/** Harbor imports SelfBench's agent adapters (runtime/*.py) from here. */
export function harborPythonPath(): string {
  return fileURLToPath(new URL("./runtime/", import.meta.url));
}
