import { posix } from "node:path";
import type { SandboxRequest } from "./contracts.js";

const MAX_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const SANDBOX_WORK_DIRECTORY = "/work";

export function validateSandboxRequest(request: SandboxRequest): void {
  if (!request.runId || !request.stage) {
    throw new Error("sandbox run ID and stage must not be empty");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 100) {
    throw new Error("sandbox timeout must be an integer of at least 100ms");
  }
  if (request.timeoutMs > MAX_SANDBOX_TIMEOUT_MS) {
    throw new Error("sandbox timeout cannot exceed 24 hours");
  }
  if (
    request.inactivityTimeoutMs !== undefined &&
    (!Number.isInteger(request.inactivityTimeoutMs) || request.inactivityTimeoutMs < 1)
  ) {
    throw new Error("sandbox inactivity timeout must be a positive integer");
  }
  if (request.command.length === 0 || !request.command[0]) {
    throw new Error("sandbox command must not be empty");
  }
  for (const path of [
    ...(request.files ?? []).map((file) => file.path),
    ...(request.outputPaths ?? []),
  ]) {
    assertSandboxWorkPath(path);
  }
  if (request.cpu !== undefined && (!Number.isInteger(request.cpu) || request.cpu < 1)) {
    throw new Error("sandbox CPU must be a positive integer");
  }
  if (
    request.memoryMiB !== undefined &&
    (!Number.isInteger(request.memoryMiB) || request.memoryMiB < 1)
  ) {
    throw new Error("sandbox memory must be a positive integer");
  }
}

export function assertSandboxWorkPath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    path.includes("\0") ||
    !path.startsWith(`${SANDBOX_WORK_DIRECTORY}/`) ||
    !normalized.startsWith(`${SANDBOX_WORK_DIRECTORY}/`)
  ) {
    throw new Error(`sandbox path must be beneath ${SANDBOX_WORK_DIRECTORY}: ${path}`);
  }
}
