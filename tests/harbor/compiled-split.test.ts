import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_TASK_FILE, SNAPSHOT_FILE, writeCompiled } from "../../src/sandbox/gate-bundle.js";
import { gzippedTar } from "../support/tar.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function work() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-compiled-split-"));
  roots.push(root);
  return root;
}

test("a compiled bundle is written with the gate task and snapshot image builds read", async () => {
  const root = await work();
  const bundle = await gzippedTar({
    "harbor-task/task.toml": "",
    "harbor-task/environment/repo.tar.gz": "snapshot",
    "harbor-task/tests/repo.tar.gz": "snapshot",
  });
  await writeCompiled(root, bundle, "{}\n");
  expect(await Bun.file(join(root, GATE_TASK_FILE)).exists()).toBe(true);
  expect(await Bun.file(join(root, SNAPSHOT_FILE)).text()).toBe("snapshot");
});

test("a compiled bundle that cannot be split fails the compile instead of verifying without images", async () => {
  const root = await work();
  const bundle = await gzippedTar({ "harbor-task/task.toml": "" });
  await expect(writeCompiled(root, bundle, "{}\n")).rejects.toThrow();
});
