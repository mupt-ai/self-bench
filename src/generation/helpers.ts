import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import { projectRoot } from "../lib/project-paths.js";
import type { SandboxCostSnapshot, SandboxRunOptions } from "../sandbox/index.js";
import {
  type ProvenanceMessage,
  provenanceMessageSchema,
} from "../third_party/github/provenance.js";

/** A bundled program or extension from the package root (dist/…, src/…). */
export function readAsset(relativePath: string): Promise<Buffer> {
  return readFile(join(projectRoot(import.meta.url), relativePath));
}

export function parseProvenance(bytes: Uint8Array): ProvenanceMessage[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => provenanceMessageSchema.parse(JSON.parse(line)));
}

/**
 * Heartbeats every minute (and on each cost update) while `action` runs, and hands it the
 * activity's cancellation signal. The latest sandbox cost rides along for the progress pages.
 */
export async function withHeartbeats<T>(
  detail: string,
  action: (options: SandboxRunOptions & { readonly signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const context = Context.current();
  let cost: SandboxCostSnapshot | undefined;
  const beat = () => context.heartbeat(cost ? { detail, cost } : { detail });
  beat();
  const timer = setInterval(beat, 60_000);
  timer.unref();
  try {
    return await action({
      signal: context.cancellationSignal,
      onCost: (snapshot) => {
        cost = snapshot;
        beat();
      },
    });
  } finally {
    clearInterval(timer);
  }
}

/** Heartbeats inside a Temporal activity; a no-op elsewhere (unit tests, the API). */
export function safeHeartbeat(detail: string): void {
  try {
    Context.current().heartbeat(detail);
  } catch {
    // Not inside an activity.
  }
}
