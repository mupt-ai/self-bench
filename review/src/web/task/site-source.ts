import { createApiClient, type TaskSource } from "../../sources/types";
import type { CandidateArtifacts, TaskFiles, TaskRow } from "../../types";
import { type TaskItem, taskArtifactsPath } from "../api";
import type { TaskRef } from "./review-queue";

const MAX_CACHED_BUNDLES = 8;
/** Bundles by key, oldest first. Bundle objects are written once, so a key never goes stale. */
const bundles = new Map<string, Promise<TaskFiles>>();

function cachedBundle(runId: string, key: string): Promise<TaskFiles> {
  const found = bundles.get(key);
  if (found) {
    bundles.delete(key);
    bundles.set(key, found);
    return found;
  }
  const loading = createApiClient("")
    .json<TaskFiles>(`/v1/runs/${encodeURIComponent(runId)}/bundle?key=${encodeURIComponent(key)}`)
    .catch((error: unknown) => {
      bundles.delete(key);
      throw error;
    });
  bundles.set(key, loading);
  for (const oldest of bundles.keys()) {
    if (bundles.size <= MAX_CACHED_BUNDLES) break;
    bundles.delete(oldest);
  }
  return loading;
}

/** Loads a task's files ahead of the reviewer opening it, so moving to the next task is instant. */
export async function prefetchTaskFiles(org: string, fullName: string, task: TaskRef) {
  const found = await createApiClient("").json<CandidateArtifacts>(
    taskArtifactsPath(org, fullName, task.runId, task.taskId),
  );
  const first = found.bundles[0];
  if (first) await cachedBundle(task.runId, first.key);
}

/**
 * The Ledger's TaskSource for one task in the site: artifacts come from the repo-scoped route
 * (no Temporal), bundles and raw artifacts from the run routes the session already unlocks.
 */
export function siteTaskSource(org: string, fullName: string, task: TaskItem): TaskSource {
  const api = createApiClient("");
  const runId = encodeURIComponent(task.runId);
  const artifacts = (): Promise<CandidateArtifacts> =>
    api.json<CandidateArtifacts>(taskArtifactsPath(org, fullName, task.runId, task.taskId));
  const loadBundle = (key: string): Promise<TaskFiles> => cachedBundle(task.runId, key);
  return {
    kind: "run",
    label: task.runId,
    rows: [rowFor(task)],
    artifacts,
    loadBundle,
    readArtifact: (key, options) =>
      api.text(
        `/v1/runs/${runId}/artifacts?key=${encodeURIComponent(key)}${
          options?.start ? `&start=${options.start}` : ""
        }`,
      ),
    loadFiles: async (id) => {
      const found = await artifacts();
      const bundle = found.bundles[0];
      if (!bundle) return { taskId: id, files: [] };
      return loadBundle(bundle.key);
    },
  };
}

export function rowFor(task: TaskItem): TaskRow {
  return {
    id: task.taskId,
    name: task.taskId,
    candidateId: task.candidateId,
    difficulty: task.difficulty,
    status: task.pipelineStatus,
    stage: task.stage as TaskRow["stage"],
    ...(task.sourcePr ? { sourcePr: task.sourcePr } : {}),
    ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
    ...(task.reasonSummary ? { reasonSummary: task.reasonSummary } : {}),
  };
}
