import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../../src/process.js";
import { prepareRepairTask } from "../../../src/sandbox/programs/prepare-repair.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repair sandbox preparation", () => {
  test("extracts a nested task and prepares its repository with the held-out patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-prepare-repair-"));
    roots.push(root);
    const source = join(root, "source/harbor-task");
    const repository = join(root, "repository");
    const work = join(root, "work");
    await Promise.all([
      mkdir(join(source, "tests"), { recursive: true }),
      mkdir(repository),
      mkdir(work),
    ]);
    await Promise.all([
      writeFile(join(source, "instruction.md"), "Fix it.\n"),
      writeFile(join(repository, "base.txt"), "base\n"),
      writeFile(
        join(source, "tests/test.patch"),
        "diff --git a/held-out.txt b/held-out.txt\nnew file mode 100644\n--- /dev/null\n+++ b/held-out.txt\n@@ -0,0 +1 @@\n+test\n",
      ),
    ]);
    await runCommand("tar", ["-czf", join(source, "tests/repo.tar.gz"), "-C", repository, "."]);
    const archive = join(root, "task.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", join(root, "source"), "."]);

    const prepared = await prepareRepairTask(archive, work);

    expect(prepared.extractedDirectory).toBe(join(work, "task"));
    expect(prepared.taskDirectory).toBe(join(work, "task/harbor-task"));
    expect(await readFile(join(prepared.repositoryDirectory, "base.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(prepared.repositoryDirectory, "held-out.txt"), "utf8")).toBe(
      "test\n",
    );
    expect(
      (await runCommand("git", ["-C", prepared.repositoryDirectory, "diff", "--name-only", "HEAD"]))
        .stdout,
    ).toBe("held-out.txt\n");
  });
});
