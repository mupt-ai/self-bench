import { afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { initialEvaluation, saveEvaluation } from "../../src/evaluation/store.js";
import { runCommand } from "../../src/lib/process.js";
import { credentialedInput } from "./evaluation-fixture.js";
import { memoryVault } from "./evaluation-vault.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A saved evaluation of one packed Harbor task, ready for a mocked Harbor run. `files` adds to the
 * task's tree by relative path.
 */
export async function runnerFixture(
  toml = 'version = "1.0"',
  change?: Parameters<typeof credentialedInput>[1],
  files: Readonly<Record<string, string>> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "evaluation-test-"));
  directories.push(root);
  const task = join(root, "task", "harbor-task");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "task.toml"), toml);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(task, path)), { recursive: true });
    await writeFile(join(task, path), text);
  }
  await runCommand("tar", [
    "-czf",
    join(root, "task.tar.gz"),
    "-C",
    join(root, "task"),
    "harbor-task",
  ]);
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const vault = memoryVault();
  const input = await credentialedInput(vault, change);
  await store.put(
    input.tasks[0]?.bundleKey ?? "",
    await readFile(join(root, "task.tar.gz")),
    "application/gzip",
  );
  await saveEvaluation(store, initialEvaluation(input, "Test model"));
  return { root, store, input, vault };
}
