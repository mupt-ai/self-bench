import { isRecord } from "../../lib/util.js";

const SMOKE_FAILURES = new Set(["SmokeCheckFailed", "AgentTimeoutError"]);
interface SmokeResult {
  readonly failed: boolean;
  readonly exitCode?: number;
  readonly output: string;
}

export function smokeResult(trial: unknown): SmokeResult {
  const agent = isRecord(trial) ? trial.agent_result : undefined;
  const metadata = isRecord(agent) && isRecord(agent.metadata) ? agent.metadata : {};
  const output = typeof metadata.smoke_output === "string" ? metadata.smoke_output : "";
  const exitCode =
    typeof metadata.smoke_exit_code === "number" ? metadata.smoke_exit_code : undefined;
  const info = isRecord(trial) ? trial.exception_info : undefined;
  const raised = isRecord(info) && SMOKE_FAILURES.has(String(info.exception_type));
  // SmokeAgent raises on a non-zero exit, so a trial without one got past smoke (or never built).
  return {
    failed: raised || (exitCode ?? 0) !== 0,
    output,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

export function smokeLog(smoke: SmokeResult, error: string | undefined): string {
  if (!smoke.failed) return smoke.output;
  const status =
    smoke.exitCode === undefined
      ? `The smoke command did not finish in the agent environment${error ? ` (${error})` : ""}.`
      : `The smoke command exited ${smoke.exitCode} in the agent environment.`;
  return [
    status,
    "It ran exactly as the solver agent will: in the agent image, as root, with network limited to the model provider. Anything the agent needs (package managers, toolchains, Corepack shims, browsers) must be installed and cached by the Dockerfile, not downloaded on first use.",
    smoke.output,
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}
