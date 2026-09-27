import type { ArtifactStore } from "../../artifacts/index.js";

const RUN_ID = /^runs\/([a-z0-9][a-z0-9-]{2,62})\//;
const LISTING_TTL_MS = 60_000;
const runIndexCache = new WeakMap<ArtifactStore, { at: number; runs: Promise<ArchivedRun[]> }>();

export interface ArchivedRun {
  readonly runId: string;
  readonly status: "ARCHIVED";
  readonly startedAt?: string;
}

/**
 * Runs that exist in the artifact store, whether or not Temporal still remembers them.
 * The index walks every run in the store, so it is cached like the per-run listings.
 */
export function listArchivedRuns(store: ArtifactStore): Promise<ArchivedRun[]> {
  const hit = runIndexCache.get(store);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.runs;
  const cached = { at: Date.now(), runs: scanArchivedRuns(store) };
  runIndexCache.set(store, cached);
  // A failed scan lists nothing now but is not cached, so the next request retries the store.
  cached.runs = cached.runs.catch(() => {
    if (runIndexCache.get(store) === cached) runIndexCache.delete(store);
    return [];
  });
  return cached.runs;
}

async function scanArchivedRuns(store: ArtifactStore): Promise<ArchivedRun[]> {
  const entries = await store.list("runs");
  const runs = new Map<string, string | undefined>();
  for (const entry of entries) {
    const runId = RUN_ID.exec(entry.key)?.[1];
    if (!runId) continue;
    const seen = runs.get(runId);
    if (!runs.has(runId) || (entry.updatedAt && (!seen || entry.updatedAt < seen))) {
      runs.set(runId, entry.updatedAt);
    }
  }
  return [...runs.entries()]
    .map(([runId, startedAt]) => ({
      runId,
      status: "ARCHIVED" as const,
      ...(startedAt ? { startedAt } : {}),
    }))
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}
