import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDigest } from "../artifacts/common.js";
import type { ArtifactStore } from "../artifacts/index.js";
import { MAX_REGISTRY_TASKS } from "../contracts/harbor-registry.js";
import { runnable } from "../db/task-record.js";
import { variantRunnable } from "../db/task-variants.js";
import type { TaskStore } from "../db/tasks.js";
import { TASK_LIMITS } from "../generation/task/render.js";
import { assertHarborVersion, HARBOR_PROCESS_TIMEOUT_MS } from "../harnesses/harbor/command.js";
import { checkRegistryTask, downloadRegistryTasks } from "../harnesses/harbor/registry-tasks.js";
import { extractRegularArchive } from "../lib/archive.js";
import { runCommand } from "../lib/process.js";
import { evaluationTaskKey } from "./models.js";
import { assertEvaluationBundleSize } from "./task-bundle.js";
import type { EvaluationInput } from "./types.js";

type EvaluationTask = EvaluationInput["tasks"][number];

/** What every generated task asks for (render.ts); a trial still checks its own task.toml. */
const GENERATED_TASK_RESOURCES = {
  cpus: TASK_LIMITS.cpus,
  memoryMb: TASK_LIMITS.memoryMb,
  storageMb: TASK_LIMITS.storageMb,
};

/**
 * The selected tasks of a repository as its evaluations run them: approved, with bundles. A key may
 * name an accepted variant of an approved task (its own run), which runs from its own bundle.
 */
export async function repositoryTasks(
  tasks: TaskStore,
  repoId: number,
  selected: readonly { runId: string; taskId: string }[],
): Promise<EvaluationTask[]> {
  if (
    new Set(selected.map((task) => evaluationTaskKey(task.runId, task.taskId))).size !==
    selected.length
  )
    throw new Error("Duplicate task selection");
  // A retry may have been opened before deletion, or come from an older run's trials.
  const [everyTask, deletedVariants] = await Promise.all([
    tasks.listWithDeleted(repoId),
    tasks.variants.listDeleted(repoId),
  ]);
  const deleted = new Set(
    [...everyTask.filter((task) => task.deleted), ...deletedVariants].map((task) =>
      evaluationTaskKey(task.runId, task.taskId),
    ),
  );
  const remaining = selected.filter(
    (task) => !deleted.has(evaluationTaskKey(task.runId, task.taskId)),
  );
  if (remaining.length === 0) throw new Error("No selected tasks remain in this repository");
  const approved = new Map(
    everyTask.filter((task) => !task.deleted && runnable(task)).map((task) => [task.id, task]),
  );
  const resolved = await Promise.all(
    remaining.map(async (picked) => {
      const task = await tasks.find(repoId, picked.runId, picked.taskId);
      if (task) return runnable(task) ? task : undefined;
      // A variant runs while it is accepted and the task it changes is still approved.
      const variant = await tasks.variants.find(repoId, picked.runId);
      return variant &&
        variant.taskId === picked.taskId &&
        variantRunnable(variant) &&
        approved.has(variant.parentId)
        ? variant
        : undefined;
    }),
  );
  if (resolved.some((task) => !task))
    throw new Error("Every task must be human-approved in this repository");
  return resolved.map((task) => {
    if (!task?.bundleKey) throw new Error("Task bundle unavailable");
    const { runId, taskId, bundleKey, images } = task;
    return {
      runId,
      taskId,
      bundleKey,
      resources: GENERATED_TASK_RESOURCES,
      ...(images ? { images } : {}),
    };
  });
}

/**
 * Freezes the Harbor registry tasks and datasets `references` name into task bundles, so a
 * comparison runs them as it runs a repository's tasks. Each task is downloaded once, checked as
 * published (checkRegistryTask), and stored unchanged as `harbor-task/` in a bundle: its trials
 * unpack exactly what was checked, however the registry changes, and run it with its own limits
 * (`minutes` bounds the run). Nothing is stored unless every task passes. A
 * task is known by its content digest (runId) and package name (taskId), so the same task in two
 * datasets runs once.
 */
export async function freezeRegistryTasks(
  store: ArtifactStore,
  references: readonly string[],
  env: NodeJS.ProcessEnv,
  command: typeof runCommand = runCommand,
): Promise<EvaluationTask[]> {
  if (references.length === 0) return [];
  const path = env.PATH ?? "";
  const version = await command("harbor", ["--version"], {
    env: { PATH: path, HARBOR_TELEMETRY: "off" },
    timeoutMs: HARBOR_PROCESS_TIMEOUT_MS.version,
  });
  assertHarborVersion(version.stdout);
  const root = await mkdtemp(join(tmpdir(), "selfbench-registry-"));
  try {
    const packed = new Map<string, { task: EvaluationTask; archive: string }>();
    for (const [index, reference] of references.entries()) {
      const downloaded = await downloadRegistryTasks(reference, join(root, `${index}`), {
        command,
        path,
      });
      for (const task of downloaded) {
        const runId = `harbor:${task.digest}`;
        const key = evaluationTaskKey(runId, task.name);
        if (packed.has(key)) continue;
        if (packed.size >= MAX_REGISTRY_TASKS)
          throw new Error(`Select at most ${MAX_REGISTRY_TASKS} registry tasks`);
        let checked: Awaited<ReturnType<typeof checkRegistryTask>>;
        try {
          checked = await checkRegistryTask(task.directory, env);
        } catch (error) {
          if (error instanceof Error) error.message = `${task.name}: ${error.message}`;
          throw error;
        }
        const { archive, sha256 } = await packTask(task.directory, join(root, `b${packed.size}`));
        const bundleKey = `harbor-registry/${task.name}/${sha256}.tar.gz`;
        const registry = `${task.name}@${task.digest}`;
        packed.set(key, {
          task: {
            runId,
            taskId: task.name,
            bundleKey,
            registry,
            minutes: checked.minutes,
            ...(Object.keys(checked.resources).length ? { resources: checked.resources } : {}),
            ...(checked.judge.variables.length ? { judge: checked.judge } : {}),
          },
          archive,
        });
      }
    }
    for (const { task, archive } of packed.values())
      await store.putFile(task.bundleKey, archive, "application/gzip");
    return [...packed.values()].map(({ task }) => task);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A checked task directory as a bundle, refused here if a trial would refuse to unpack it. */
async function packTask(directory: string, bundle: string) {
  await mkdir(bundle);
  await rename(directory, join(bundle, "harbor-task"));
  const archive = join(bundle, "task.tar.gz");
  await runCommand("tar", ["-czf", archive, "-C", bundle, "harbor-task"]);
  const { sha256, sizeBytes } = await fileDigest(archive);
  assertEvaluationBundleSize(sizeBytes);
  const check = join(bundle, "check");
  await mkdir(check);
  await extractRegularArchive(archive, check);
  await rm(check, { recursive: true });
  return { archive, sha256 };
}
