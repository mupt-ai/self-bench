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
 * Each `harbor run` is a Python client peaking near 300 MiB regardless of what the sandbox does
 * (measured in the production image: 40 concurrent Modal nop gates used 7.6 GiB). A gate peaks
 * near 105 MiB with Harbor telemetry off, but solver trials share these slots and Harbor's Codex
 * and Claude Code agents import litellm on the worker to price calls, so slots keep the larger
 * figure. Its unpacked task sits in /tmp, which is memory on Cloud Run, and carries the repository
 * snapshot (bundles averaged ~365 MB in a September 2026 PostHog batch). Sandbox-driving
 * activities cost the worker almost nothing, so only Harbor slots are sized to host memory.
 * This module stays free of Node imports because the browser bundle reaches `config.ts`.
 */
const RESERVED_BYTES = 2.25 * 1024 ** 3;
const BYTES_PER_HARBOR_PROCESS = 256 * 1024 ** 2;
const BYTES_PER_HARBOR_TASK = 512 * 1024 ** 2;
const MINIMUM = 2;

export function harborSlotsForMemory(memoryBytes: number): number {
  const perSlot = BYTES_PER_HARBOR_PROCESS + BYTES_PER_HARBOR_TASK;
  return Math.min(
    MAX_HARBOR_CONCURRENCY,
    Math.max(MINIMUM, Math.floor((memoryBytes - RESERVED_BYTES) / perSlot)),
  );
}
