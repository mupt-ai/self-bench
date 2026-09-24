import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { MAX_HARBOR_CONCURRENCY } from "../contracts/config/execution-limits.js";
import { harborSlotsForMemory } from "../contracts/config/worker-capacity.js";

/** Harbor slots for this worker: the explicit setting, else sized to the cgroup or host memory. */
export function resolveHarborConcurrency(configured: number | undefined): number {
  return Math.min(
    MAX_HARBOR_CONCURRENCY,
    configured ?? harborSlotsForMemory(availableMemoryBytes()),
  );
}

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

/** `harbor` runs a Harbor-only replica that polls only the Harbor queue, adding Harbor slots. */
export function workerQueues(env: NodeJS.ProcessEnv = process.env): "all" | "harbor" {
  const value = env.SELFBENCH_WORKER_QUEUES?.trim() || "all";
  if (value !== "all" && value !== "harbor")
    throw new Error("SELFBENCH_WORKER_QUEUES must be all or harbor");
  return value;
}
