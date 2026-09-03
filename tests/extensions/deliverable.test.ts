import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixDeliverable } from "../../src/extensions/shared/deliverable.js";
import { runCommand } from "../../src/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ fix: string; task: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-fix-deliverable-"));
  roots.push(root);
  const fix = join(root, "fix");
  const task = join(root, "task");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(fix),
    mkdir(join(task, "tests"), { recursive: true }),
    mkdir(join(task, "solution"), { recursive: true }),
    mkdir(repo),
  ]);
  await Promise.all([
    writeFile(
      join(task, "definition.json"),
      JSON.stringify({
        taskId: "t",
        prompt: "p",
        testCommand: "a {tests}",
        environment: { smokeCommand: "x" },
      }),
    ),
    writeFile(join(task, "tests/test.patch"), "diff --git a/tests/a b/tests/a\n"),
    writeFile(join(task, "solution/gold.patch"), "diff --git a/src/a b/src/a\n"),
  ]);
  await runCommand("git", ["init", "-q", repo]);
  await runCommand("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await runCommand("git", ["-C", repo, "config", "user.name", "T"]);
  await writeFile(join(repo, "tests.txt"), "base\n");
  await runCommand("git", ["-C", repo, "add", "."]);
  await runCommand("git", ["-C", repo, "commit", "-qm", "base"]);
  return { fix, task, repo };
}

describe("verifier fix deliverable", () => {
  test("merges only fix fields from /work/fix/definition.json and uses the test.patch file when present", async () => {
    const { fix, task, repo } = await workspace();
    await writeFile(
      join(fix, "definition.json"),
      JSON.stringify({
        testCommand: "b {tests}",
        prompt: "sneaky",
        environment: { smokeCommand: "y" },
      }),
    );
    await writeFile(join(fix, "test.patch"), "diff --git a/tests/a b/tests/a\n+fixed\n");

    const loaded = loadFixDeliverable(fix, task, repo);

    expect("isError" in loaded).toBe(false);
    if ("isError" in loaded) return;
    expect(loaded.definition).toEqual({
      taskId: "t",
      prompt: "p",
      testCommand: "b {tests}",
      environment: { smokeCommand: "y" },
    });
    expect(loaded.testPatch).toContain("+fixed");
    expect(loaded.testPatchSource).toBe("file");
    expect(loaded.goldPatch).toBe("diff --git a/src/a b/src/a\n");
  });

  test("regenerates test.patch from the working tree when the file is absent", async () => {
    const { fix, task, repo } = await workspace();
    await writeFile(join(repo, "tests.txt"), "base\nedited\n");

    const loaded = loadFixDeliverable(fix, task, repo);

    expect("isError" in loaded).toBe(false);
    if ("isError" in loaded) return;
    expect(loaded.testPatchSource).toBe("working-tree");
    expect(loaded.testPatch).toContain("+edited");
    expect(loaded.definition.testCommand).toBe("a {tests}");
  });

  test("reports an empty fix and invalid definition JSON as file errors", async () => {
    const { fix, task, repo } = await workspace();
    const empty = loadFixDeliverable(fix, task, repo);
    expect("isError" in empty && empty.content[0]?.text).toContain(
      "test.patch is absent and /work/repo has no changes",
    );
    await writeFile(join(fix, "definition.json"), "{");
    const invalid = loadFixDeliverable(fix, task, repo);
    expect("isError" in invalid && invalid.content[0]?.text).toContain(
      "[files] definition.json is not valid JSON",
    );
  });
});
