import type { ArtifactStore } from "../../artifacts/index.js";
import { isArtifactRegistry } from "../../contracts/config/task-images.js";
import type { TaskImages } from "../../contracts/index.js";
import type { Database } from "../../db/client.js";
import type { Vault } from "../../db/vault.js";
import { holdingCapacity } from "../../sandbox/capacity.js";
import type { TaskImageBuilder } from "../images/builder.js";
import { discardCandidateImages } from "../images/registry.js";
import type { GateImages } from "../pipeline/harbor-gates.js";
import { withHeartbeats } from "../pipeline/helpers.js";
import { type ConversionOutcome, convertTask } from "./task-conversion.js";
import {
  needsImages,
  type RebuildDependencies,
  type RebuildOutcome,
  rebuildTaskImages,
  verificationEnvironment,
} from "./task-image-rebuild.js";
import {
  type ReviewedTask,
  type TaskImageOutcome,
  taskImageReconciler,
  taskImageRows,
} from "./task-images.js";

export interface TaskImageActivities {
  /** Removes a rejected or deleted task's images; says when a kept task has none. */
  reconcileTaskImages(taskRowId: number): Promise<TaskImageOutcome>;
  /** Kept tasks that run on their Dockerfiles, optionally within some repositories. */
  tasksWithoutImages(repoIds?: readonly number[]): Promise<number[]>;
  /** Kept tasks still authored as definition.json, optionally within some repositories. */
  legacyTasks(repoIds?: readonly number[]): Promise<number[]>;
}

export interface TaskImageRebuildActivities {
  rebuildTaskImages(taskRowId: number): Promise<RebuildOutcome>;
  convertTask(taskRowId: number): Promise<ConversionOutcome>;
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
  /** The task image repository, whose images are deleted only in Artifact Registry. */
  repository: string | undefined,
  rebuild: Omit<RebuildOptions, "db" | "store" | "repository"> | undefined,
): { taskImages: Partial<TaskImageActivities>; rebuilds: Partial<TaskImageRebuildActivities> } {
  if (!db) return { taskImages: {}, rebuilds: {} };
  const builds = !!rebuild && !!repository;
  return {
    taskImages: createTaskImageActivities({ db, store, repository, builds }),
    rebuilds:
      rebuild && repository
        ? createTaskImageRebuildActivities({ ...rebuild, db, store, repository })
        : {},
  };
}

/** Behind selfBenchTaskImagesWorkflow on the workflow queue: rows and a few registry calls. */
function createTaskImageActivities(options: {
  readonly db: Database;
  readonly store: ArtifactStore;
  readonly repository: string | undefined;
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
    legacyTasks: (repoIds) => rows.legacy(repoIds),
  };
}

/**
 * The rebuild and the conversion on the Harbor queue: each runs the task's gates, holding a slot
 * of the verifying credential throughout, as a check does.
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
  /** Runs `check` on the row's verifying account, with its images saved by `save`. */
  const checking = async <Outcome extends { readonly status: string }>(
    taskRowId: number,
    step: {
      readonly label: string;
      /** Why the row has nothing to check, if it has not. */
      readonly skip?: (task: ReviewedTask) => string | undefined;
      readonly save: (
        task: ReviewedTask,
        bundleKey: string,
        images: TaskImages,
      ) => Promise<boolean>;
      readonly check: (task: ReviewedTask, deps: RebuildDependencies) => Promise<Outcome>;
    },
  ): Promise<Outcome | { readonly status: "skipped"; readonly reason: string }> => {
    const task = await rows.find(taskRowId);
    if (!task) return { status: "skipped", reason: "Task row is gone" };
    const reason = step.skip?.(task);
    if (reason) return { status: "skipped", reason };
    const verification = await verificationEnvironment(options.vault, task.runId, process.env);
    const outcome = await holdingCapacity(
      options.vault,
      verification.orgId,
      [verification.credentialId],
      () =>
        withHeartbeats(`${step.label} ${task.taskId}`, (signal) =>
          step.check(task, {
            builder: options.builder,
            verification,
            serving: options.serving,
            save: (bundleKey, images) => step.save(task, bundleKey, images),
            // A local registry keeps its images; only Artifact Registry's are deleted.
            discardImages: async (keep) => {
              if (!isArtifactRegistry(options.repository)) return;
              const kept = keep ? [keep.agent, keep.verifier] : [];
              await discardCandidateImages(
                options.repository,
                task.runId,
                task.candidateId,
                async (digest) =>
                  kept.some((image) => image.endsWith(`@${digest}`)) ||
                  (await rows.referenced([digest], task.id)),
              );
            },
            signal,
          }),
        ),
      true,
    );
    log({ taskRowId, taskId: task.taskId, ...outcome });
    return outcome;
  };
  return {
    rebuildTaskImages: (taskRowId) =>
      checking(taskRowId, {
        label: "rebuilding the images of",
        skip: (task) => (needsImages(task) ? undefined : "Nothing to rebuild"),
        save: rows.save,
        check: (task, deps) => rebuildTaskImages(options.store, task, deps),
      }),
    convertTask: (taskRowId) =>
      checking(taskRowId, {
        label: "converting",
        save: rows.saveConverted,
        check: (task, deps) => convertTask(options.store, task, deps),
      }),
  };
}
