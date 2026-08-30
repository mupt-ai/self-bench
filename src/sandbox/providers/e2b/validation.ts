import type { SandboxInfo } from "e2b";
import { normalizeE2BDomain, normalizeE2BTemplateReference } from "../../../setup/e2b/template.js";
import type { SandboxRequest } from "../../contracts.js";
import { validateSandboxRequest } from "../../request-validation.js";
import type { E2BExecutionConfig, E2BLifecycleTimings } from "./config.js";

export function validateConfig(config: E2BExecutionConfig): E2BExecutionConfig {
  const image = normalizeE2BTemplateReference(config.image);
  const apiKey = config.credentials.apiKey.trim();
  const domain = normalizeE2BDomain(config.credentials.domain);
  if (!image || image === "base") {
    throw new Error("E2B execution requires a nonblank custom SelfBench template");
  }
  if (!apiKey) {
    throw new Error("E2B execution requires a nonblank API key");
  }
  return {
    kind: "e2b",
    image,
    timeoutCapMs: config.timeoutCapMs,
    credentials: { apiKey, ...(domain ? { domain } : {}) },
  };
}

export function validateLifecycleTimings(timings: E2BLifecycleTimings): E2BLifecycleTimings {
  for (const [name, value] of Object.entries({
    cleanupCallTimeoutMs: timings.cleanupCallTimeoutMs,
    cleanupTimeoutMs: timings.cleanupTimeoutMs,
    commandKillGraceMs: timings.commandKillGraceMs,
    diagnosticTimeoutMs: timings.diagnosticTimeoutMs,
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`E2B lifecycle ${name} must be a positive integer`);
    }
  }
  if (
    timings.cleanupRecoveryDelaysMs.length === 0 ||
    timings.cleanupRecoveryDelaysMs.some((value) => !Number.isInteger(value) || value < 0)
  ) {
    throw new Error("E2B cleanup recovery delays must be nonnegative integers");
  }
  return timings;
}

export function validateRequest(request: SandboxRequest): {
  readonly cpu: number;
  readonly memoryMiB: number;
} {
  validateSandboxRequest(request);
  return { cpu: request.cpu ?? 4, memoryMiB: request.memoryMiB ?? 8192 };
}

export function validateAllocatedSandbox(
  sandboxId: string,
  info: Pick<
    SandboxInfo,
    "sandboxId" | "state" | "cpuCount" | "memoryMB" | "metadata" | "lifecycle"
  >,
  expected: { readonly cpu: number; readonly memoryMiB: number },
  metadata: Readonly<Record<string, string>>,
): void {
  if (info.sandboxId !== sandboxId) {
    throw new Error(`E2B returned sandbox info for ${info.sandboxId}; expected ${sandboxId}`);
  }
  if (info.state !== "running") {
    throw new Error(`E2B sandbox ${sandboxId} was created in unexpected state ${info.state}`);
  }
  if (info.lifecycle?.onTimeout !== "kill") {
    throw new Error(`E2B sandbox ${sandboxId} did not retain lifecycle onTimeout=kill`);
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (info.metadata[key] !== value) {
      throw new Error(`E2B sandbox ${sandboxId} did not retain allocation metadata ${key}`);
    }
  }
  if (info.cpuCount !== expected.cpu || info.memoryMB !== expected.memoryMiB) {
    throw new Error(
      `E2B template allocated ${info.cpuCount} CPU/${info.memoryMB} MiB for sandbox ${sandboxId}; expected ${expected.cpu} CPU/${expected.memoryMiB} MiB`,
    );
  }
}
