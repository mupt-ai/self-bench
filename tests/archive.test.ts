import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRegularArchive } from "../src/archive.js";
import { runCommand } from "../src/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("extractRegularArchive", () => {
  test("extracts regular files and internal symbolic links", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const output = join(root, "output");
    const archive = join(root, "archive.tar.gz");
    await Promise.all([mkdir(source), mkdir(output)]);
    await writeFile(join(source, "value.txt"), "safe\n");
    await symlink("value.txt", join(source, "value-link"));
    await runCommand("tar", ["-czf", archive, "-C", source, "."]);

    await extractRegularArchive(archive, output, { allowSymlinks: true });

    expect(await readFile(join(output, "value-link"), "utf8")).toBe("safe\n");
  });

  test("rejects symbolic links that escape the destination", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const output = join(root, "output");
    const archive = join(root, "archive.tar.gz");
    await Promise.all([mkdir(source), mkdir(output)]);
    await symlink("../../outside", join(source, "escape"));
    await runCommand("tar", ["-czf", archive, "-C", source, "."]);

    await expect(extractRegularArchive(archive, output, { allowSymlinks: true })).rejects.toThrow(
      "symbolic link escapes destination",
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-archive-"));
  roots.push(root);
  return root;
}
