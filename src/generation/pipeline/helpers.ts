import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef } from "../../contracts/index.js";
import { projectRoot } from "../../lib/project-paths.js";
import type { SandboxFile } from "../../sandbox/index.js";
import {
  type ProvenanceMessage,
  provenanceMessageSchema,
} from "../../third_party/github/provenance.js";

/** A bundled program or extension from the package root (dist/…, src/…). */
export function readAsset(relativePath: string): Promise<Buffer> {
  return readFile(join(projectRoot(import.meta.url), relativePath));
}

/** An artifact as a sandbox file: pulled from a signed URL when the store has one. */
export async function artifactFile(
  store: ArtifactStore,
  artifact: ArtifactRef,
  path: string,
): Promise<SandboxFile> {
  const url = await store.signedReadUrl?.(artifact, 2 * 60 * 60_000).catch(() => undefined);
  if (url) return { path, url, sha256: artifact.sha256 };
  return { path, contents: await store.get(artifact) };
}

export function parseProvenance(bytes: Uint8Array): ProvenanceMessage[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => provenanceMessageSchema.parse(JSON.parse(line)));
}

/** Heartbeats every minute while `action` runs, and hands it the activity's cancellation signal. */
export async function withHeartbeats<T>(
  detail: string,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const context = Context.current();
  const beat = () => context.heartbeat({ detail });
  beat();
  const timer = setInterval(beat, 60_000);
  timer.unref();
  try {
    return await action(context.cancellationSignal);
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

/** The Temporal attempt, so a retried verification publishes under fresh live keys. */
export function activityAttempt(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1; // Not inside an activity (tests, local runs).
  }
}
