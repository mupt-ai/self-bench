import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportIgnoredPaths, malformedPatchProblems, patchApplyCheck } from "../src/patch-check.js";
import { runCommand } from "../src/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<{ repo: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-patch-check-"));
  roots.push(root);
  const repo = join(root, "repo");
  await runCommand("git", ["init", "-q", repo]);
  await runCommand("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await runCommand("git", ["-C", repo, "config", "user.name", "T"]);
  await writeFile(join(repo, "src.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "test.txt"), "old test\n");
  await runCommand("git", ["-C", repo, "add", "."]);
  await runCommand("git", ["-C", repo, "commit", "-qm", "base"]);
  const base = (await runCommand("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  // Dirty the working tree the way an agent would; the check must ignore it.
  await writeFile(join(repo, "src.txt"), "agent scratch\n");
  await writeFile(join(repo, "untracked.txt"), "scratch\n");
  return { repo, base };
}

const testPatch = `diff --git a/test.txt b/test.txt
--- a/test.txt
+++ b/test.txt
@@ -1 +1 @@
-old test
+new test
`;
const goldPatch = `diff --git a/src.txt b/src.txt
--- a/src.txt
+++ b/src.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

describe("patch apply check", () => {
  test("rejects patches that touch export-ignored paths, including via an ancestor directory", async () => {
    const { repo, base: dirtyBase } = await repository();
    await writeFile(
      join(repo, ".gitattributes"),
      ".github/ export-ignore\ndocs/internal.md export-ignore\n",
    );
    await runCommand("git", ["-C", repo, "add", ".gitattributes"]);
    await runCommand("git", ["-C", repo, "commit", "-qm", "attributes"]);
    const base = (await runCommand("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    expect(base).not.toBe(dirtyBase);
    const ignoredTest = `diff --git a/.github/scripts/check.py b/.github/scripts/check.py
new file mode 100644
--- /dev/null
+++ b/.github/scripts/check.py
@@ -0,0 +1 @@
+print("hi")
`;
    const errors = await patchApplyCheck({
      repository: repo,
      base,
      testPatch: ignoredTest,
      goldPatch,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("test.patch touches .github/scripts/check.py");
    expect(errors[0]?.message).toContain("export-ignore");
    const worktree = (await runCommand("git", ["-C", repo, "worktree", "list"])).stdout
      .trim()
      .split("\n");
    expect(worktree).toHaveLength(1);
    const scratch = join(repo, "..", "attr-check");
    await runCommand("git", ["-C", repo, "worktree", "add", "--detach", scratch, base]);
    expect(await exportIgnoredPaths(scratch, ["docs/internal.md", "src.txt", ".github/x"])).toEqual(
      [".github/x", "docs/internal.md"],
    );
    await runCommand("git", ["-C", repo, "worktree", "remove", "--force", scratch]);
  });

  test("accepts patches that apply to the clean base in both orders despite a dirty working tree", async () => {
    const { repo, base } = await repository();
    expect(await patchApplyCheck({ repository: repo, base, testPatch, goldPatch })).toEqual([]);
    expect(
      (await runCommand("git", ["-C", repo, "worktree", "list"])).stdout.trim().split("\n"),
    ).toHaveLength(1);
  });

  test("reports a corrupt patch with git's message", async () => {
    const { repo, base } = await repository();
    const corrupt = `${goldPatch.split("\n").slice(0, 5).join("\n")}\n`;
    const errors = await patchApplyCheck({ repository: repo, base, testPatch, goldPatch: corrupt });
    expect(errors).toEqual([
      {
        gate: "patch",
        message: expect.stringMatching(
          /^gold\.patch does not apply to the clean base tree: .*corrupt patch/,
        ),
      },
    ]);
  });

  test("reports a patch whose context conflicts with the base", async () => {
    const { repo, base } = await repository();
    const conflicting = testPatch.replace("-old test", "-something else");
    const errors = await patchApplyCheck({
      repository: repo,
      base,
      testPatch: conflicting,
      goldPatch,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(
      /^test\.patch does not apply to the clean base tree: .*patch does not apply/,
    );
  });

  test("checks the oracle order: gold on top of test", async () => {
    const { repo, base } = await repository();
    const goldTouchingTests = `${goldPatch}${testPatch.replace("+new test", "+gold wants old test")}`;
    const errors = await patchApplyCheck({
      repository: repo,
      base,
      testPatch,
      goldPatch: goldTouchingTests,
    });
    expect(errors).toEqual([
      {
        gate: "patch",
        message: expect.stringContaining(
          "gold.patch does not apply on top of test.patch (the oracle order)",
        ),
      },
    ]);
  });

  test("reports an unavailable base ref", async () => {
    const { repo } = await repository();
    const errors = await patchApplyCheck({
      repository: repo,
      base: "f".repeat(40),
      testPatch,
      goldPatch,
    });
    expect(errors[0]?.message).toContain("is not available in");
  });

  test("flags malformed patch text before git sees it", () => {
    expect(malformedPatchProblems(testPatch, "test patch")).toEqual([]);
    expect(malformedPatchProblems(testPatch.replaceAll("\n", "\r\n"), "test patch")).toEqual([
      "test patch has CRLF line endings; write it with LF only",
    ]);
    expect(malformedPatchProblems(testPatch.trimEnd(), "test patch")).toEqual([
      "test patch is missing its final newline",
    ]);
    expect(malformedPatchProblems("--- a\n+++ b\n", "gold patch")).toEqual([
      "gold patch must be a Git patch starting with diff --git",
    ]);
  });
});
