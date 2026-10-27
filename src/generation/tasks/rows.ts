import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef, AuthoredTask } from "../../contracts/index.js";
import type { TaskVerdict } from "../../db/task-lifecycle.js";

/** The artifact key of a stored reference (`…/runs/<runId>/…` in every backend). */
function artifactKey(reference: ArtifactRef): string | undefined {
  const index = reference.uri.indexOf("/runs/");
  return index < 0 ? undefined : reference.uri.slice(index + 1);
}

/** The bundle, definition, and pinned images of an accepted task, written onto its row once. */
export async function acceptedTaskFields(
  artifacts: ArtifactStore,
  task: AuthoredTask,
): Promise<Pick<TaskVerdict, "bundleKey" | "definition" | "images">> {
  const bundleKey = artifactKey(task.bundle);
  const definition = JSON.parse(Buffer.from(await artifacts.get(task.definition)).toString("utf8"));
  return {
    ...(bundleKey ? { bundleKey } : {}),
    definition,
    ...(task.images ? { images: task.images } : {}),
  };
}
