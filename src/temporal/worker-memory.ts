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
