import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import { extractRegularArchive } from "../../archive.js";
import type { ArtifactStore } from "../../artifacts.js";
import { type ArtifactRef, taskDefinitionSchema } from "../../contracts.js";
import { refreshHarborTask } from "../../harbor-task.js";
import { sha256 } from "../../hash.js";
import { runCommand } from "../../process.js";
import { withTemporaryDirectory } from "./runtime.js";
import type { ExportInput } from "./types.js";

export async function buildExport(store: ArtifactStore, input: ExportInput): Promise<ArtifactRef> {
  return await withTemporaryDirectory("selfbench-export-", async (root) => {
    const tasksRoot = join(root, "tasks");
    await mkdir(tasksRoot, { recursive: true });
    const manifestTasks: { taskId: string; sha256: string }[] = [];
    for (const task of input.tasks) {
      const bundle = await store.get(task.bundle);
      const path = join(tasksRoot, `${task.taskId}.tar.gz`);
      const expanded = join(root, `expanded-${task.taskId}`);
      const sourceArchive = join(expanded, "source.tar.gz");
      await mkdir(expanded, { recursive: true });
      await writeFile(sourceArchive, bundle);
      await extractRegularArchive(sourceArchive, expanded);
      const definition = taskDefinitionSchema.parse(
        JSON.parse(Buffer.from(await store.get(task.definition)).toString("utf8")),
      );
      await refreshHarborTask(join(expanded, "harbor-task"), definition);
      await runCommand("tar", ["-czf", path, "-C", expanded, "harbor-task"]);
      manifestTasks.push({ taskId: task.taskId, sha256: sha256(await readFile(path)) });
    }
    await writeFile(
      join(root, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: input.run.runId,
          candidateCounts: input.run.candidateCounts,
          repository: input.run.repository,
          version: input.run.version,
          acceptedCount: manifestTasks.length,
          tasks: manifestTasks,
        },
        null,
        2,
      )}\n`,
    );
    const archive = join(root, "export.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", root, "manifest.json", "tasks"]);
    return await store.putFile(
      `runs/${input.run.runId}/export/attempt-${Context.current().info.attempt}/selfbench-${input.run.runId}.tar.gz`,
      archive,
      "application/gzip",
    );
  });
}
