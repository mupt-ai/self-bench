import { access, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../lib/process.js";

const ENVIRONMENT_SNAPSHOT = "harbor-task/environment/repo.tar.gz";
const TESTS_SNAPSHOT = "harbor-task/tests/repo.tar.gz";

/** What a remote Harbor check needs, written next to the compiled bundle. */
export const GATE_TASK_FILE = "gate-task.tar.gz";
export const SNAPSHOT_FILE = "repo.tar.gz";

/**
 * Splits a compiled bundle into the Harbor task without its repository snapshots and the
 * environment snapshot on its own. A remote image build fetches the snapshot itself, so the
 * worker running the check only ever holds the small task. The compiled bundle is unchanged.
 * Tasks with services build through Compose instead and keep the full bundle.
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
  const compose = join(gate, "harbor-task/environment/docker-compose.yaml");
  const hasServices = await access(compose).then(
    () => true,
    () => false,
  );
  if (hasServices) {
    await rm(gate, { recursive: true });
    return;
  }
  await runCommand("tar", ["-czf", join(work, GATE_TASK_FILE), "-C", gate, "harbor-task"]);
  await mkdir(snapshot);
  await runCommand("tar", ["-xzf", compiled, "-C", snapshot, ENVIRONMENT_SNAPSHOT]);
  await rename(join(snapshot, ENVIRONMENT_SNAPSHOT), join(work, SNAPSHOT_FILE));
}
