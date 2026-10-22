import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { unpackTrialTask } from "../../src/evaluation/task-bundle.js";
import { expandBundle } from "../../src/generation/runs/bundle.js";
import { compactCandidate, keptBundles } from "../../src/generation/runs/compact.js";
import {
  attemptSnapshot,
  SNAPSHOT_POINTER_FILE,
  sharedSnapshotKey,
} from "../../src/generation/task/snapshot-store.js";
import { runCommand } from "../../src/lib/process.js";
import { readSnapshotLink } from "../../src/sandbox/snapshot-link.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const candidate = "runs/run-1/verify/cand-a";
const first = `${candidate}/authoring-round-1-turn-1/compile/attempt-1`;
const second = `${candidate}/authoring-round-1-turn-2/compile/attempt-1`;

/** A compile attempt as the compiler writes it: full bundle, gate task and snapshot. */
async function attempt(
  store: LocalArtifactStore,
  root: string,
  directory: string,
  options: { snapshot: Buffer; gateTest?: string },
) {
  const work = await mkdtemp(join(root, "attempt-"));
  const task = join(work, "harbor-task");
  await mkdir(join(task, "environment"), { recursive: true });
  await mkdir(join(task, "tests"), { recursive: true });
  await writeFile(join(task, "task.toml"), '[task]\nname = "task-a"\n');
  await writeFile(join(task, "instruction.md"), "Do the thing.\n");
  for (const context of ["environment", "tests"])
    await writeFile(
      join(task, context, "Dockerfile"),
      "FROM scratch\nCOPY repo.tar.gz /tmp/repo.tar.gz\n",
    );
  await writeFile(join(task, "tests/test.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(task, "environment/repo.tar.gz"), options.snapshot);
  await writeFile(join(task, "tests/repo.tar.gz"), options.snapshot);
  await runCommand("tar", ["-czf", join(work, "full.tar.gz"), "-C", work, "harbor-task"]);
  if (options.gateTest) await writeFile(join(task, "tests/test.sh"), options.gateTest);
  await runCommand("tar", [
    "-czf",
    join(work, "gate.tar.gz"),
    "-C",
    work,
    "--exclude=harbor-task/environment/repo.tar.gz",
    "--exclude=harbor-task/tests/repo.tar.gz",
    "harbor-task",
  ]);
  await store.putFile(
    `${directory}/harbor-task.tar.gz`,
    join(work, "full.tar.gz"),
    "application/gzip",
  );
  await store.putFile(
    `${directory}/gate-task.tar.gz`,
    join(work, "gate.tar.gz"),
    "application/gzip",
  );
  await store.put(`${directory}/repo.tar.gz`, options.snapshot, "application/gzip");
}

async function fixture(gateTest?: string) {
  const root = await mkdtemp(join(tmpdir(), "selfbench-compact-"));
  roots.push(root);
  const store = new LocalArtifactStore(join(root, "store"));
  const snapshot = Buffer.alloc(64 * 1024, 7);
  await attempt(store, root, first, { snapshot, ...(gateTest ? { gateTest } : {}) });
  await attempt(store, root, second, { snapshot });
  const digest = createHash("sha256").update(snapshot).digest("hex");
  return { store, snapshot, digest };
}

test("a dry run reports what applying frees and changes nothing", async () => {
  const { store, snapshot } = await fixture();
  const bundle = await store.stat(`${first}/harbor-task.tar.gz`);
  const result = await compactCandidate(store, "run-1", "cand-a", {
    kept: new Set([`${second}/harbor-task.tar.gz`]),
    apply: false,
    seen: new Set(),
  });
  expect(result).toEqual({
    snapshotsShared: 2,
    bundlesDeleted: 1,
    freedBytes: snapshot.length + (bundle?.sizeBytes ?? 0),
    mismatched: [],
  });
  expect(await store.stat(`${first}/repo.tar.gz`)).toBeDefined();
  expect(await store.stat(`${first}/harbor-task.tar.gz`)).toBeDefined();
});

test("snapshots keep one shared copy; unkept full bundles go; readers follow the pointer", async () => {
  const { store, snapshot, digest } = await fixture();
  const bundle = await store.stat(`${first}/harbor-task.tar.gz`);
  const kept = keptBundles([`${second}/harbor-task.tar.gz`]);
  const result = await compactCandidate(store, "run-1", "cand-a", { kept, apply: true });
  expect(result).toEqual({
    snapshotsShared: 2,
    bundlesDeleted: 1,
    freedBytes: snapshot.length + (bundle?.sizeBytes ?? 0),
    mismatched: [],
  });
  const shared = await store.stat(sharedSnapshotKey(digest));
  expect(shared?.sha256).toBe(digest);
  for (const directory of [first, second]) {
    expect(await store.stat(`${directory}/repo.tar.gz`)).toBeUndefined();
    expect(await store.stat(`${directory}/${SNAPSHOT_POINTER_FILE}`)).toBeDefined();
    expect(await attemptSnapshot(store, directory)).toEqual({
      key: sharedSnapshotKey(digest),
      sha256: digest,
      sizeBytes: snapshot.length,
    });
  }
  expect(await store.stat(`${first}/harbor-task.tar.gz`)).toBeUndefined();
  expect(await store.stat(`${second}/harbor-task.tar.gz`)).toBeDefined();
  // The viewer still shows the deleted bundle's task, snapshots listed by size.
  const expanded = await expandBundle(store, `${first}/harbor-task.tar.gz`);
  const paths = new Map(expanded?.files.map((file) => [file.path, file.sizeBytes]));
  expect(paths.get("instruction.md")).toBeGreaterThan(0);
  expect(paths.get("environment/repo.tar.gz")).toBe(snapshot.length);
  // Repeating it changes nothing more.
  expect(await compactCandidate(store, "run-1", "cand-a", { kept, apply: true })).toEqual({
    snapshotsShared: 0,
    bundlesDeleted: 0,
    freedBytes: 0,
    mismatched: [],
  });
});

test("a gate task that does not rebuild its bundle keeps the bundle", async () => {
  const { store } = await fixture("#!/bin/sh\nexit 1\n");
  const result = await compactCandidate(store, "run-1", "cand-a", {
    kept: new Set(),
    apply: true,
  });
  expect(result.mismatched).toEqual([`${first}/harbor-task.tar.gz`]);
  expect(result.bundlesDeleted).toBe(1);
  expect(await store.stat(`${first}/harbor-task.tar.gz`)).toBeDefined();
  expect(await store.stat(`${second}/harbor-task.tar.gz`)).toBeUndefined();
});

test("an execution bundle keeps the compiled bundle it was published from", () => {
  const execution = `${first}/execution-abc/execution-task.tar.gz`;
  expect([...keptBundles([execution])]).toEqual([execution, `${first}/harbor-task.tar.gz`]);
});

test("a pointer may only name the shared copy of its own digest", async () => {
  const { store, digest } = await fixture();
  expect(() => sharedSnapshotKey("not-a-digest")).toThrow();
  await store.put(
    `${candidate}/forged/${SNAPSHOT_POINTER_FILE}`,
    Buffer.from(JSON.stringify({ key: `${first}/repo.tar.gz`, sha256: digest, sizeBytes: 1 })),
    "application/json",
  );
  await expect(attemptSnapshot(store, `${candidate}/forged`)).rejects.toThrow("unshared key");
});

test("the local store copies without overwriting and deletes idempotently", async () => {
  const { store, snapshot } = await fixture();
  const copied = await store.copy(`${first}/repo.tar.gz`, "copies/one.tar.gz");
  expect(await store.copy(`${first}/repo.tar.gz`, "copies/one.tar.gz")).toEqual(copied);
  await expect(store.copy(`${first}/gate-task.tar.gz`, "copies/one.tar.gz")).rejects.toThrow(
    "different contents",
  );
  await store.delete("copies/one.tar.gz");
  await store.delete("copies/one.tar.gz");
  expect(await store.stat("copies/one.tar.gz")).toBeUndefined();
  expect(await readFile(new URL((await store.stat(`${first}/repo.tar.gz`))?.uri ?? ""))).toEqual(
    snapshot,
  );
});

test("a Modal trial of a compacted task fetches the shared snapshot", async () => {
  const { store, digest } = await fixture();
  const kept = new Set([`${second}/harbor-task.tar.gz`]);
  await compactCandidate(store, "run-1", "cand-a", { kept, apply: true });
  const root = await mkdtemp(join(tmpdir(), "selfbench-trial-"));
  roots.push(root);
  const directory = await unpackTrialTask(
    store,
    { runId: "run-1", taskId: "task-a", bundleKey: `${second}/harbor-task.tar.gz` },
    "modal",
    root,
    { snapshotLink: { url: "https://app.example", secret: "secret" } },
  );
  const dockerfile = await readFile(join(directory, "environment/Dockerfile"), "utf8");
  const line = dockerfile.split("\n").find((text) => text.startsWith("ADD "));
  expect(line).toContain(`--checksum=sha256:${digest}`);
  const url = new URL(line?.split(" ")[2] ?? "");
  expect(readSnapshotLink(url.pathname, "secret")).toEqual({
    key: sharedSnapshotKey(digest),
    sha256: digest,
  });
});
