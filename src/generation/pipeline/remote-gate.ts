import { createWriteStream } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef } from "../../contracts/index.js";
import { extractRegularArchive } from "../../lib/archive.js";

/**
 * The Harbor task without its repository snapshots, and where an image build on Modal fetches the
 * snapshot instead (a trial of a task without images, src/evaluation/task-bundle.ts).
 */
export interface RemoteGate {
  readonly bundle: ArtifactRef;
  readonly snapshotUrl: string;
  readonly snapshotSha256: string;
}

const SNAPSHOT_COPY = "COPY repo.tar.gz /tmp/repo.tar.gz";

/**
 * Points both image builds (the agent's `environment/` and the separate verifier's `tests/`) at
 * the snapshot's link, pinned to its digest, instead of the copy the full bundle carries.
 */
export async function fetchSnapshotInBuild(
  taskDirectory: string,
  remote: RemoteGate,
): Promise<void> {
  const fetch = `ADD --checksum=sha256:${remote.snapshotSha256} ${remote.snapshotUrl} /tmp/repo.tar.gz`;
  for (const context of ["environment", "tests"]) {
    const dockerfile = join(taskDirectory, context, "Dockerfile");
    const lines = (await readFile(dockerfile, "utf8")).split("\n");
    const index = lines.indexOf(SNAPSHOT_COPY);
    if (index < 0) throw new Error(`${context}/Dockerfile does not copy the repository snapshot`);
    lines[index] = fetch;
    await writeFile(dockerfile, lines.join("\n"));
  }
}

/**
 * Unpacks a Harbor task bundle under `root`. Full bundles run to hundreds of MB and Cloud Run's
 * /tmp is memory: the archive is streamed to disk rather than buffered, and dropped once unpacked.
 */
export async function unpackTask(
  store: ArtifactStore,
  bundle: ArtifactRef,
  root: string,
  signal: AbortSignal,
): Promise<string> {
  const archive = join(root, "task.tar.gz");
  await pipeline(await store.openRead(bundle), createWriteStream(archive), { signal });
  await extractRegularArchive(archive, root, { signal });
  await rm(archive);
  return join(root, "harbor-task");
}
