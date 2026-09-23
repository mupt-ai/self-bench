import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactEntry } from "./types.js";

const RUN_ID = /^runs\/([a-z0-9][a-z0-9-]{2,62})\//;
const LISTING_TTL_MS = 60_000;
let runIndexCache: { at: number; runs: Promise<ArchivedRun[]> } | undefined;

export function clearArchivedListingCache(): void {
  runIndexCache = undefined;
}

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
  if (runIndexCache && Date.now() - runIndexCache.at < LISTING_TTL_MS) return runIndexCache.runs;
  const runs = scanArchivedRuns(store);
  const cached = { at: Date.now(), runs };
  runIndexCache = cached;
  runs.catch(() => {
    if (runIndexCache === cached) runIndexCache = undefined;
  });
  return runs;
}

async function scanArchivedRuns(store: ArtifactStore): Promise<ArchivedRun[]> {
  const entries = await store.list("runs").catch(() => [] as ArtifactEntry[]);
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
