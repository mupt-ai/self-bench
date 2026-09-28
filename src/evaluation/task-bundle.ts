import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/index.js";
import type { ArtifactRef } from "../contracts/index.js";
import { fetchSnapshotInBuild, unpackTask } from "../generation/pipeline/remote-gate.js";
import type { SandboxCallback } from "../generation/pipeline/sandbox-job.js";
import { extractRegularArchive } from "../lib/archive.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE } from "../sandbox/gate-bundle.js";
import { snapshotLinkUrl } from "../sandbox/snapshot-link.js";
import type { EvaluationInput } from "./types.js";

// PostHog task bundles include compressed repository snapshots larger than 350 MiB.
// Keep a bounded compressed size; extractRegularArchive separately caps unpacked data.
export const MAX_EVALUATION_BUNDLE_BYTES = 512 * 1024 * 1024;

export function assertEvaluationBundleSize(size: number): void {
  if (size > MAX_EVALUATION_BUNDLE_BYTES) throw new Error("Task bundle exceeds 512 MiB");
}

const COMPILED_BUNDLE = "/harbor-task.tar.gz";

/**
 * Unpacks the Harbor task one trial runs under `trialRoot` and returns its directory.
 *
 * On Modal, a task whose compile also wrote the snapshot-free gate task is read from that, and
 * its image builds fetch the snapshot through the same link its verification used: the worker
 * never holds the two repository snapshots, and a trial whose pinned images are gone (or that
 * has none) builds the very Dockerfiles verification built, which Modal may still have cached.
 * Every other trial unpacks the full bundle.
 */
export async function unpackTrialTask(
  store: ArtifactStore,
  task: EvaluationInput["tasks"][number],
  sandbox: EvaluationInput["sandbox"],
  trialRoot: string,
  options: { snapshotLink?: SandboxCallback; signal?: AbortSignal },
): Promise<string> {
  const split =
    sandbox === "modal" && options.snapshotLink
      ? await splitBundle(store, task.bundleKey).catch(() => undefined)
      : undefined;
  if (split && options.snapshotLink) {
    const root = join(trialRoot, "task");
    await mkdir(root);
    const directory = await unpackTask(
      store,
      split.gate,
      root,
      options.signal ?? new AbortController().signal,
    );
    const { url, secret } = options.snapshotLink;
    await fetchSnapshotInBuild(directory, {
      bundle: split.gate,
      snapshotUrl: snapshotLinkUrl(url, split.snapshot, secret),
      snapshotSha256: split.snapshot.sha256,
    });
    return directory;
  }
  const bundle = await store.getByKey(task.bundleKey);
  if (!bundle) throw new Error("Task bundle is missing");
  assertEvaluationBundleSize(bundle.byteLength);
  const archive = join(trialRoot, "task.tar.gz");
  await writeFile(archive, bundle, { mode: 0o600 });
  const extracted = join(trialRoot, "task");
  await mkdir(extracted);
  await extractRegularArchive(archive, extracted, options.signal ? { signal: options.signal } : {});
  return await readFile(join(extracted, "harbor-task", "task.toml")).then(
    () => join(extracted, "harbor-task"),
    () => extracted,
  );
}

/** The gate task and snapshot a compile wrote beside its bundle; undefined for older compiles. */
async function splitBundle(
  store: ArtifactStore,
  bundleKey: string,
): Promise<{ gate: ArtifactRef; snapshot: { key: string; sha256: string } } | undefined> {
  if (!bundleKey.endsWith(COMPILED_BUNDLE)) return undefined;
  const directory = bundleKey.slice(0, -COMPILED_BUNDLE.length);
  const snapshotKey = `${directory}/${SNAPSHOT_FILE}`;
  const [gate, snapshot] = await Promise.all([
    store.stat(`${directory}/${GATE_TASK_FILE}`),
    store.stat(snapshotKey),
  ]);
  if (!gate || !snapshot) return undefined;
  assertEvaluationBundleSize(gate.sizeBytes);
  return {
    gate: { ...gate, contentType: "application/gzip" },
    snapshot: { key: snapshotKey, sha256: snapshot.sha256 },
  };
}
