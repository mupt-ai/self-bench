import type { ArtifactStore } from "../../artifacts/index.js";
import { isArtifactRegistry } from "../../contracts/config/task-images.js";
import type { Database } from "../../db/client.js";
import type { Vault } from "../../db/vault.js";
import { holdingCapacity } from "../../sandbox/capacity.js";
import type { TaskImageBuilder } from "../images/builder.js";
import { removeRegistryImage } from "../images/registry.js";
import type { GateImages } from "../pipeline/harbor-gates.js";
import { withHeartbeats } from "../pipeline/helpers.js";
import {
  needsImages,
  type RebuildOutcome,
  rebuildTaskImages,
  verificationEnvironment,
} from "./task-image-rebuild.js";
import { type TaskImageOutcome, taskImageReconciler, taskImageRows } from "./task-images.js";

export interface TaskImageActivities {
  /** Removes a rejected or deleted task's images; says when a kept task has none. */
  reconcileTaskImages(taskRowId: number): Promise<TaskImageOutcome>;
  /** Kept tasks that run on their Dockerfiles, optionally within some repositories. */
  tasksWithoutImages(repoIds?: readonly number[]): Promise<number[]>;
}

export interface TaskImageRebuildActivities {
  rebuildTaskImages(taskRowId: number): Promise<RebuildOutcome>;
}

const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ event: "task-images", ...event }));

type RebuildOptions = Parameters<typeof createTaskImageRebuildActivities>[0];

/**
 * A worker's task-image activities. The reconcile asks for a rebuild only where the Harbor workers
 * register one; every worker of a deployment reads the same settings, so they agree.
 */
export function taskImageWorkerActivities(
  db: Database | undefined,
  store: ArtifactStore,
  rebuild: Omit<RebuildOptions, "db" | "store"> | undefined,
): { taskImages: Partial<TaskImageActivities>; rebuilds: Partial<TaskImageRebuildActivities> } {
  if (!db) return { taskImages: {}, rebuilds: {} };
  return {
    taskImages: createTaskImageActivities({ db, store, builds: !!rebuild }),
    rebuilds: rebuild ? createTaskImageRebuildActivities({ ...rebuild, db, store }) : {},
  };
}

/** Behind selfBenchTaskImagesWorkflow on the workflow queue: rows and a few registry calls. */
function createTaskImageActivities(options: {
  readonly db: Database;
  readonly store: ArtifactStore;
  /** Whether this deployment builds images, so a kept task without them can be given them. */
  readonly builds: boolean;
}): TaskImageActivities {
  const rows = taskImageRows(options.db);
  const reconcile = taskImageReconciler(options);
  return {
    async reconcileTaskImages(taskRowId) {
      const task = await rows.find(taskRowId);
      if (!task) return { status: "skipped", reason: "Task row is gone" };
      const outcome: TaskImageOutcome =
        options.builds && needsImages(task) ? { status: "unbuilt" } : await reconcile(task);
      log({ taskRowId, taskId: task.taskId, ...outcome });
      return outcome;
    },
    tasksWithoutImages: (repoIds) => rows.withoutImages(repoIds),
  };
}

/**
 * The rebuild on the Harbor queue: it runs the task's gates, holding a slot of the verifying
 * credential throughout, as a check does.
 */
function createTaskImageRebuildActivities(options: {
  readonly db: Database;
  readonly store: ArtifactStore;
  readonly vault: Pick<Vault, "records" | "credentials">;
  readonly builder: TaskImageBuilder;
  readonly repository: string;
  readonly serving: GateImages["serving"];
}): TaskImageRebuildActivities {
  const rows = taskImageRows(options.db);
  return {
    async rebuildTaskImages(taskRowId) {
      const task = await rows.find(taskRowId);
      if (!task) return { status: "skipped", reason: "Task row is gone" };
      if (!needsImages(task)) return { status: "skipped", reason: "Nothing to rebuild" };
      const verification = await verificationEnvironment(options.vault, task.runId, process.env);
      const outcome = await holdingCapacity(
        options.vault,
        verification.orgId,
        [verification.credentialId],
        () =>
          withHeartbeats(`rebuilding ${task.taskId}'s images`, (signal) =>
            rebuildTaskImages(options.store, task, {
              builder: options.builder,
              verification,
              serving: options.serving,
              save: (bundleKey, images) => rows.save(task, bundleKey, images),
              // A local registry keeps its images; only Artifact Registry's are deleted.
              removeImages: async (images) => {
                if (!isArtifactRegistry(options.repository)) return;
                for (const image of [images.agent, images.verifier])
                  await removeRegistryImage(image);
              },
              signal,
            }),
          ),
        true,
      );
      log({ taskRowId, taskId: task.taskId, ...outcome });
      return outcome;
    },
  };
}
