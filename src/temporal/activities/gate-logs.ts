import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import type { ArtifactRef } from "../../contracts.js";
import { COMPOSE_DIAGNOSTICS_MARKER, excerptLog } from "../../log-excerpt.js";
import { runCommand } from "../../process.js";

export interface GateLog {
  readonly logTail: string;
  readonly log: ArtifactRef;
}

/** Stores the complete raw log for a gate and returns the actionable excerpt alongside its ref. */
export async function storeGateLog(
  store: ArtifactStore,
  key: string,
  raw: string,
): Promise<GateLog> {
  const log = await store.put(
    key,
    Buffer.from(raw.length > 0 ? raw : "(empty log)\n"),
    "text/plain",
  );
  return { logTail: excerptLog(raw), log };
}

export function isUnhealthyServiceFailure(text: string): boolean {
  return /unhealthy|dependency failed|healthcheck/i.test(text);
}

/**
 * `docker compose ps` plus the last 30 log lines of each failed service for the trial's compose
 * project (Harbor names it after the trial: `<trial_name>__env`). Harbor usually tears the project
 * down before we get here, in which case the block says so instead of being silently empty.
 */
export async function composeDiagnostics(
  trial: unknown,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  run: typeof runCommand = runCommand,
): Promise<string> {
  const trialName = trialNameOf(trial);
  if (harborEnvironment !== "docker") {
    return `${COMPOSE_DIAGNOSTICS_MARKER}: not available on the ${harborEnvironment} Harbor environment; the compose project cannot be inspected from the worker.`;
  }
  if (!trialName) {
    return `${COMPOSE_DIAGNOSTICS_MARKER}: Harbor's trial name is missing from the result, so the compose project could not be located.`;
  }
  const project = composeProjectName(`${trialName}__env`);
  const ps = await run("docker", ["compose", "-p", project, "ps", "-a", "--format", "table"], {
    allowFailure: true,
    timeoutMs: 30_000,
  }).catch((error: unknown) => ({
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  const services = ps.stdout.trim().split("\n").slice(1).filter(Boolean);
  if (ps.exitCode !== 0 || services.length === 0) {
    return `${COMPOSE_DIAGNOSTICS_MARKER} (project ${project}): the compose project is no longer available (Harbor deletes it after the run), so service status and logs could not be fetched.${ps.stderr.trim() ? ` docker said: ${ps.stderr.trim().slice(0, 300)}` : ""}`;
  }
  const lines = [`${COMPOSE_DIAGNOSTICS_MARKER} (project ${project})`, ps.stdout.trimEnd()];
  for (const row of services) {
    const service = row.split(/\s+/)[0];
    if (!service || /\bhealthy\b|\brunning\b(?!.*unhealthy)/i.test(row) === true) {
      continue;
    }
    const logs = await run("docker", ["compose", "-p", project, "logs", "--tail", "30", service], {
      allowFailure: true,
      timeoutMs: 30_000,
    }).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    lines.push(
      `--- ${service} (last 30 lines) ---`,
      logs.stdout.trimEnd() || logs.stderr.trimEnd() || "(no output)",
    );
  }
  return lines.join("\n");
}

function trialNameOf(trial: unknown): string | undefined {
  const name =
    typeof trial === "object" && trial !== null
      ? (trial as { trial_name?: unknown }).trial_name
      : undefined;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Mirrors Harbor's compose project sanitization: lowercase, alphanumeric start, safe characters. */
export function composeProjectName(name: string): string {
  const lower = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return /^[a-z0-9]/.test(lower) ? lower : `0${lower}`;
}
