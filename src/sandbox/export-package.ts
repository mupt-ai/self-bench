import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../hash.js";
import { runCommand } from "../process.js";

/** Accepted bundles are immutable. Packaging must not rewrite the tests that were verified. */
export async function packageExport(): Promise<void> {
  const input = JSON.parse(await readFile("/work/export-input.json", "utf8"));
  const root = "/work/export";
  await mkdir(join(root, "tasks"), { recursive: true });
  const tasks = [];
  for (const [index, taskId] of input.taskIds.entries()) {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId))
      throw Error("Invalid export task ID");
    const bytes = await readFile(`/work/bundle-${index}.tar.gz`);
    await writeFile(join(root, "tasks", `${taskId}.tar.gz`), bytes);
    tasks.push({ taskId, sha256: sha256(bytes) });
  }
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({ ...input.manifest, tasks, acceptedCount: tasks.length }, null, 2)}\n`,
  );
  await runCommand("tar", ["-czf", "/work/export.tar.gz", "-C", root, "manifest.json", "tasks"]);
}
