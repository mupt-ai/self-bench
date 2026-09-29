import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { runCommand } from "../lib/process.js";

/**
 * Accepted bundles are immutable. Packaging must not rewrite the tests that were verified.
 * The sandbox disk (about 21 GB on managed E2B) holds the staged bundles and the archive, so
 * bundles are moved rather than copied and tar deletes each one once it is archived.
 */
export async function packageExport(): Promise<void> {
  const input = JSON.parse(await readFile("/work/export-input.json", "utf8"));
  const root = "/work/export";
  await mkdir(join(root, "tasks"), { recursive: true });
  const tasks = [];
  for (const [index, taskId] of input.taskIds.entries()) {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId))
      throw Error("Invalid export task ID");
    const path = join(root, "tasks", `${taskId}.tar.gz`);
    await rename(`/work/bundle-${index}.tar.gz`, path);
    tasks.push({ taskId, sha256: await fileSha256(path) });
  }
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({ ...input.manifest, tasks, acceptedCount: tasks.length }, null, 2)}\n`,
  );
  await runCommand("tar", [
    "-czf",
    "/work/export.tar.gz",
    "--remove-files",
    "-C",
    root,
    "manifest.json",
    "tasks",
  ]);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
