import { ApplicationFailure } from "@temporalio/common";
import type { SelfBenchConfig } from "../../config.js";
import { harborChildEnvironment } from "../../harbor-environment.js";
import {
  type HarborJobResult,
  harborInfrastructureError,
  readHarborJobResult,
} from "../../harbor-results.js";
import { runCommand } from "../../process.js";

const HARBOR_INFRASTRUCTURE_FAILURE_TYPE = "HarborInfrastructureFailure";

export async function runHarborGate(
  taskDirectory: string,
  jobsDirectory: string,
  agent: "nop" | "oracle",
  taskId: string,
  environment: SelfBenchConfig["harborEnvironment"],
  signal: AbortSignal,
  quiet = true,
): Promise<HarborJobResult> {
  const jobName = `${taskId}-${agent}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await runCommand(
    "harbor",
    [
      "run",
      "--path",
      taskDirectory,
      "--agent",
      agent,
      "--env",
      environment,
      "--job-name",
      jobName,
      "--jobs-dir",
      jobsDirectory,
      "--delete",
      "--yes",
      ...(quiet ? ["--quiet"] : []),
    ],
    {
      allowFailure: true,
      env: harborChildEnvironment(),
      timeoutMs: 3 * 60 * 60 * 1000,
      signal,
    },
  );
  if (result.exitCode !== 0) {
    throw ApplicationFailure.create({
      message: harborCommandFailureMessage(
        agent,
        taskId,
        result.exitCode,
        `${result.stdout}\n${result.stderr}`,
      ),
      type: HARBOR_INFRASTRUCTURE_FAILURE_TYPE,
    });
  }
  const parsed = await readHarborJobResult(jobsDirectory, jobName);
  const infrastructureError = harborInfrastructureError(parsed.trial);
  if (infrastructureError) {
    throw ApplicationFailure.create({
      message: `Harbor ${agent} infrastructure failure for ${taskId}: ${infrastructureError}`,
      type: HARBOR_INFRASTRUCTURE_FAILURE_TYPE,
    });
  }
  return parsed;
}
function harborCommandFailureMessage(
  agent: "nop" | "oracle",
  taskId: string,
  exitCode: number,
  output: string,
): string {
  const detail = output.trim();
  return `Harbor ${agent} exited ${exitCode} for ${taskId}${detail ? `:\n${boundedTail(detail)}` : ""}`;
}
export function harborGateFailureReason(
  nopPassed: boolean,
  nopChecks: Record<string, unknown>,
  oraclePassed: boolean,
  oracleChecks: Record<string, unknown>,
  nopOutput?: string,
  oracleOutput?: string,
): string {
  const formatChecks = (checks: Record<string, unknown>): string =>
    [
      "patch_applied",
      "fail_to_pass",
      "pass_to_pass",
      "deterministic",
      "setup_completed",
      "fail_to_pass_exit_code",
      "fail_to_pass_repeat_exit_code",
      "pass_to_pass_exit_code",
    ]
      .map((key) => `${key}=${String(checks[key] ?? "missing")}`)
      .join(", ");
  const diagnostics = [
    ...(!nopPassed && nopOutput ? [`nop verifier tail:\n${boundedTail(nopOutput)}`] : []),
    ...(!oraclePassed && oracleOutput
      ? [`oracle verifier tail:\n${boundedTail(oracleOutput)}`]
      : []),
  ];
  return `Harbor gates failed: nop=${nopPassed} (${formatChecks(nopChecks)}); oracle=${oraclePassed} (${formatChecks(oracleChecks)})${diagnostics.length > 0 ? `\n${diagnostics.join("\n")}` : ""}`;
}
export function verifierOutput(
  result: Awaited<ReturnType<typeof readHarborJobResult>>,
): string | undefined {
  const combined = result.verifier?.combined;
  const stderr = result.verifier?.stderr;
  if (combined && stderr) {
    return `${combined.trimEnd()}\n\n--- verifier stderr ---\n${stderr}`;
  }
  return stderr ?? combined;
}
export function boundedTail(value: string, maxBytes = 8_000): string {
  const buffer = Buffer.from(value);
  return buffer.length <= maxBytes
    ? value.trimEnd()
    : `[truncated ${buffer.length - maxBytes} bytes]\n${buffer.subarray(-maxBytes).toString("utf8").trimEnd()}`;
}
export function rewards(trial: unknown): Record<string, unknown> {
  if (
    !isRecord(trial) ||
    !isRecord(trial.verifier_result) ||
    !isRecord(trial.verifier_result.rewards)
  ) {
    return {};
  }
  return trial.verifier_result.rewards;
}
export function exception(trial: unknown): unknown {
  return isRecord(trial) ? trial.exception_info : undefined;
}
export function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
