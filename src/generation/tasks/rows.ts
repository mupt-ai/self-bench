import { dirname } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef, AuthoredTask } from "../../contracts/index.js";
import type { TaskVerdict } from "../../db/task-lifecycle.js";
import { GATE_TASK_FILE } from "../../sandbox/gate-bundle.js";
import { publishExecutionBundle } from "../pipeline/execution-bundle.js";

/** The artifact key of a stored reference (`…/runs/<runId>/…` in every backend). */
function artifactKey(reference: ArtifactRef): string | undefined {
  const index = reference.uri.indexOf("/runs/");
  return index < 0 ? undefined : reference.uri.slice(index + 1);
}

/**
 * What an accepted task's row carries: its definition, and the bundle its trials run. A task with
 * images runs its execution bundle (Dockerfiles that are each a `FROM` of an image's digest),
 * published here from its gate task; one without builds its compiled bundle's Dockerfiles.
 */
export async function acceptedTaskFields(
  artifacts: ArtifactStore,
  task: AuthoredTask,
  signal: AbortSignal = new AbortController().signal,
): Promise<Pick<TaskVerdict, "bundleKey" | "definition" | "images">> {
  const definition = JSON.parse(Buffer.from(await artifacts.get(task.definition)).toString("utf8"));
  const compiled = artifactKey(task.bundle);
  if (!task.images || !compiled)
    return { ...(compiled ? { bundleKey: compiled } : {}), definition };
  const gate = await artifacts.stat(`${dirname(compiled)}/${GATE_TASK_FILE}`);
  if (!gate) throw new Error(`${task.taskId}'s gate task is missing`);
  const bundle = await publishExecutionBundle(
    artifacts,
    { bundle: task.bundle, images: task.images },
    { ...gate, contentType: "application/gzip" },
    signal,
  );
  const bundleKey = artifactKey(bundle);
  if (!bundleKey) throw new Error(`${task.taskId}'s execution bundle is outside its run`);
  return { bundleKey, definition, images: task.images };
}
