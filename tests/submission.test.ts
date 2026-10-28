import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSubmission } from "../src/generation/task/submission.js";
import { runCommand } from "../src/lib/process.js";
import { goldPatch, submission, testPatch } from "./support/submission-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("submission check", () => {
  test("passes a complete submission at the tier its gold reaches", () => {
    expect(checkSubmission(submission, "hard")).toEqual({
      errors: [],
      blockers: [],
      difficulty: "easy",
    });
  });

  test("names every missing file and malformed patch", () => {
    const { errors } = checkSubmission(
      {
        ...submission,
        "smoke.sh": "",
        "test.patch": testPatch.replaceAll("\n", "\r\n"),
        "gold.patch": goldPatch.trimEnd(),
      },
      "easy",
    );
    expect(errors).toEqual([
      "smoke.sh is missing or empty",
      "test.patch has CRLF line endings; write it with LF only",
      "gold.patch is missing its final newline",
    ]);
    expect(
      checkSubmission(
        { ...submission, "gold.patch": goldPatch.replace("b/src/feature.ts", "b/../escape.ts") },
        "easy",
      ).errors,
    ).toEqual([expect.stringContaining("gold.patch path escapes repository: ../escape.ts")]);
  });

  test("services.sh is optional, and held to the same secret rule", () => {
    expect(checkSubmission({ ...submission, "services.sh": "" }, "easy").errors).toEqual([]);
    expect(
      checkSubmission({ ...submission, "services.sh": "echo $NPM_TOKEN\n" }, "easy").errors,
    ).toEqual(["services.sh references secret material"]);
  });

  test("requires literal base images, the snapshot, and no secret material", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile build argument.
    const Dockerfile = "ARG BASE\nFROM ${BASE}\nRUN echo $GITHUB_TOKEN\n";
    expect(checkSubmission({ ...submission, Dockerfile }, "easy").errors).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile build argument.
      expect.stringContaining("Dockerfile FROM ${BASE} must name an image literally"),
      "Dockerfile must unpack repo.tar.gz into /app: ADD repo.tar.gz /app/",
      "Dockerfile references secret material",
    ]);
    const staged = "FROM node:22 AS build\nFROM build\nADD repo.tar.gz /app/\n";
    expect(checkSubmission({ ...submission, Dockerfile: staged }, "easy").errors).toEqual([]);
  });

  test("audits only a submission that compiles", () => {
    const overlapping = { ...submission, "test.patch": goldPatch };
    expect(checkSubmission(overlapping, "easy").blockers).toEqual([
      "gold.patch and test.patch both change src/feature.ts",
    ]);
    expect(checkSubmission({ ...overlapping, "smoke.sh": "" }, "easy").blockers).toEqual([]);
  });

  test("the sandbox-check program proves patches apply against a clean base worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-check-"));
    roots.push(root);
    const repo = join(root, "repo");
    await runCommand("git", ["init", "-q", repo]);
    await runCommand("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    await runCommand("git", ["-C", repo, "config", "user.name", "T"]);
    await writeFile(join(repo, "keep.txt"), "base\n");
    await runCommand("git", ["-C", repo, "add", "."]);
    await runCommand("git", ["-C", repo, "commit", "-qm", "base"]);
    const task = join(root, "task");
    await runCommand("mkdir", [task]);
    const check = async () => {
      const result = await runCommand("bun", [
        "run",
        "src/sandbox/programs/check.ts",
        task,
        "easy",
        repo,
        "HEAD",
      ]);
      return JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
    };
    for (const [name, contents] of Object.entries(submission)) {
      await writeFile(join(task, name), contents);
    }
    expect(await check()).toEqual({ ok: true, errors: [] });

    await writeFile(
      join(task, "gold.patch"),
      goldPatch.replace("@@ -0,0 +1,25 @@", "@@ -0,0 +1,30 @@"),
    );
    expect(await check()).toEqual({
      ok: false,
      errors: [expect.stringContaining("gold.patch does not apply to the clean base tree")],
    });
  });
});
