import { createApiClient, type TaskSource } from "../../sources/types";
import type { CandidateArtifacts, TaskFiles, TaskRow } from "../../types";
import { type TaskItem, taskArtifactsPath } from "../api";

/**
 * The Ledger's TaskSource for one task in the site: artifacts come from the repo-scoped route
 * (no Temporal), bundles and raw artifacts from the run routes the session already unlocks.
 */
export function siteTaskSource(org: string, fullName: string, task: TaskItem): TaskSource {
  const api = createApiClient("");
  const runId = encodeURIComponent(task.runId);
  let pending: Promise<CandidateArtifacts> | undefined;
  const artifacts = (): Promise<CandidateArtifacts> => {
    pending ??= api.json<CandidateArtifacts>(
      taskArtifactsPath(org, fullName, task.runId, task.taskId),
    );
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
  const loadBundle = (key: string): Promise<TaskFiles> =>
    api.json<TaskFiles>(`/v1/runs/${runId}/bundle?key=${encodeURIComponent(key)}`);
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
