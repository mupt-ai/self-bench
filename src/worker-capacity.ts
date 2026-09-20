import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { ExecutionBackend } from "./providers.js";

const DEFAULT_ACTIVITY_CONCURRENCY = {
  docker: 1,
  modal: 20,
  vercel: 4,
  e2b: 4,
} as const satisfies Record<ExecutionBackend, number>;

export function workerConcurrency(
  backend: ExecutionBackend,
  activity: number | undefined,
  harbor: number | undefined,
): { activityConcurrency: number; harborConcurrency: number } {
  return {
    activityConcurrency: activity ?? DEFAULT_ACTIVITY_CONCURRENCY[backend],
    harborConcurrency: harbor ?? harborSlotsForMemory(availableMemoryBytes()),
  };
}

/**
 * Each `harbor run` is a Python client peaking near 300 MiB regardless of what the sandbox does
 * (measured in the production image: 40 concurrent Modal nop gates used 7.6 GiB). Sandbox-driving
 * activities cost the worker almost nothing, so only Harbor slots are sized to host memory.
 */
const RESERVED_BYTES = 2.25 * 1024 ** 3;
const BYTES_PER_HARBOR_PROCESS = 256 * 1024 ** 2;
const MINIMUM = 2;

export function harborSlotsForMemory(memoryBytes: number): number {
  return Math.max(MINIMUM, Math.floor((memoryBytes - RESERVED_BYTES) / BYTES_PER_HARBOR_PROCESS));
}

/** The cgroup limit when the worker container has one, otherwise the host total. */
function availableMemoryBytes(): number {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const limit = Number(readFileSync(path, "utf8").trim());
      if (Number.isFinite(limit) && limit > 0 && limit < totalmem()) return limit;
    } catch {
      // Not in a cgroup with a memory limit.
    }
  }
  return totalmem();
}
