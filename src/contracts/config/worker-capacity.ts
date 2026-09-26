import { MAX_HARBOR_CONCURRENCY } from "./execution-limits.js";
import type { ExecutionBackend } from "./providers.js";

const DEFAULT_ACTIVITY_CONCURRENCY = {
  docker: 1,
  modal: 20,
  vercel: 4,
  e2b: 4,
} as const satisfies Record<ExecutionBackend, number>;

export function defaultActivityConcurrency(backend: ExecutionBackend): number {
  return DEFAULT_ACTIVITY_CONCURRENCY[backend];
}

/**
 * Each `harbor run` is a Python client peaking near 105 MiB regardless of what the sandbox does
 * (a Modal nop gate on Linux, Harbor 0.23.0, with its telemetry off; the telemetry's litellm
 * import added ~175 MiB at job end). A solver trial unpacks its task into /tmp, which is memory on
 * Cloud Run, and the task carries the repository snapshot (bundles averaged ~365 MB in a
 * September 2026 PostHog batch); Modal gates fetch the snapshot in the image build instead, but
 * share the slots. Sandbox-driving activities cost the worker almost nothing, so only Harbor slots
 * are sized to host memory.
 * This module stays free of Node imports because the browser bundle reaches `config.ts`.
 */
const RESERVED_BYTES = 2.25 * 1024 ** 3;
const BYTES_PER_HARBOR_PROCESS = 128 * 1024 ** 2;
const BYTES_PER_HARBOR_TASK = 512 * 1024 ** 2;
const MINIMUM = 2;

export function harborSlotsForMemory(memoryBytes: number): number {
  const perSlot = BYTES_PER_HARBOR_PROCESS + BYTES_PER_HARBOR_TASK;
  return Math.min(
    MAX_HARBOR_CONCURRENCY,
    Math.max(MINIMUM, Math.floor((memoryBytes - RESERVED_BYTES) / perSlot)),
  );
}
