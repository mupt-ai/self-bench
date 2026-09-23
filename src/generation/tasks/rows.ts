import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef, AuthoredTask, TaskProgress } from "../../contracts/index.js";
import type { PipelineStatus, TaskUpsert } from "../../db/tasks.js";

/** The artifact key of a stored reference (`…/runs/<runId>/…` in every backend). */
function artifactKey(reference: ArtifactRef): string | undefined {
  const index = reference.uri.indexOf("/runs/");
  return index < 0 ? undefined : reference.uri.slice(index + 1);
}

export function pipelineStatus(progress: Pick<TaskProgress, "status">): PipelineStatus {
  switch (progress.status) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "infrastructure_failed":
      return "infrastructure_failed";
    default:
      return "in_progress";
  }
}

/**
 * The bundle and definition of an accepted task. An unreadable definition is left off, so one
 * bad artifact never blocks the other rows; the next sync tries it again.
 */
export async function acceptedTaskFields(
  artifacts: ArtifactStore,
  task: AuthoredTask,
): Promise<Pick<TaskUpsert, "bundleKey" | "definition">> {
  const bundleKey = artifactKey(task.bundle);
  const definition = await artifacts
    .get(task.definition)
    .then((bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>)
    .catch(() => undefined);
  return { ...(bundleKey ? { bundleKey } : {}), ...(definition ? { definition } : {}) };
}
