import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../lib/process.js";

const ENVIRONMENT_SNAPSHOT = "harbor-task/environment/repo.tar.gz";
const TESTS_SNAPSHOT = "harbor-task/tests/repo.tar.gz";

/** Where the compiled bundle keeps its two copies of the repository snapshot. */
export const SNAPSHOT_PATHS = [ENVIRONMENT_SNAPSHOT, TESTS_SNAPSHOT] as const;

/** What a remote Harbor check needs, written next to the compiled bundle. */
export const GATE_TASK_FILE = "gate-task.tar.gz";
export const SNAPSHOT_FILE = "repo.tar.gz";

/**
 * Splits a compiled bundle into the Harbor task without its repository snapshots and the
 * snapshot on its own (both contexts hold the same one). The image build fetches the snapshot
 * itself, so the worker running the check only ever holds the small task. The compiled bundle is
 * unchanged.
 */
export async function splitGateBundle(compiled: string, work: string): Promise<void> {
  const gate = join(work, "gate");
  const snapshot = join(work, "snapshot");
  await mkdir(gate);
  await runCommand("tar", [
    "-xzf",
    compiled,
    "-C",
    gate,
    `--exclude=${ENVIRONMENT_SNAPSHOT}`,
    `--exclude=${TESTS_SNAPSHOT}`,
  ]);
  await runCommand("tar", ["-czf", join(work, GATE_TASK_FILE), "-C", gate, "harbor-task"]);
  await mkdir(snapshot);
  await runCommand("tar", ["-xzf", compiled, "-C", snapshot, ENVIRONMENT_SNAPSHOT]);
  await rename(join(snapshot, ENVIRONMENT_SNAPSHOT), join(work, SNAPSHOT_FILE));
}

/**
 * Writes the compiled bundle and, when there is one, its pinned definition and gate split. Image
 * builds read the split files, so a failed split fails the compile, which is retried.
 */
export async function writeCompiled(
  work: string,
  bundle: Uint8Array,
  pinnedDefinition: string,
): Promise<void> {
  await writeFile(join(work, "compiled.tar.gz"), bundle);
  if (bundle.byteLength === 0) return;
  await writeFile(join(work, "definition.json"), pinnedDefinition);
  await splitGateBundle(join(work, "compiled.tar.gz"), work);
}
