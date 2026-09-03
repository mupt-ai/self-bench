import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDefinition } from "../src/contracts.js";
import { runCommand } from "../src/process.js";
import { staticCheckSubmission } from "../src/static-check.js";

const goldPatch = `diff --git a/src/feature.ts b/src/feature.ts
new file mode 100644
--- /dev/null
+++ b/src/feature.ts
@@ -0,0 +1,25 @@
${Array.from({ length: 25 }, (_unused, index) => `+export const line${index} = ${index};`).join("\n")}
`;
const testPatch = `diff --git a/tests/feature.test.ts b/tests/feature.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/feature.test.ts
@@ -0,0 +1 @@
+test("feature", () => {});
`;

const definition: TaskDefinition = {
  schemaVersion: 2,
  difficulty: "easy",
  taskId: "static-check",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  workdir: ".",
  testCommand: "bun test {tests}",
  failToPass: ["tests/feature.test.ts"],
  passToPass: [],
  testPaths: ["tests/feature.test.ts"],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement the feature.",
  timeouts: { setupSeconds: 900, agentSeconds: 2400, testsSeconds: 900 },
  resources: { cpus: 4, memoryMb: 8192, storageMb: 20480 },
  environment: {
    schemaVersion: 1,
    baseImage: `oven/bun:1@sha256:${"b".repeat(64)}`,
    rootSetupCommand: "apt-get update && apt-get install -y bash git passwd procps tar",
    setupCommand: "bun install --frozen-lockfile",
    smokeCommand: "bun --version",
    environmentVariables: { SECRET_KEY: "selfbench-local-secret" },
    services: [],
    source: "ci-adapted",
    evidence: [{ path: ".github/workflows/ci.yml", reason: "Runs bun test." }],
  },
};

function check(overrides: Partial<TaskDefinition> = {}, patches = { testPatch, goldPatch }) {
  return staticCheckSubmission({
    definitionJson: JSON.stringify({ ...definition, ...overrides }),
    ...patches,
  });
}

describe("static submission check", () => {
  test("passes a contract whose SECRET_KEY carries a placeholder and renders the tree", () => {
    const result = check();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.rendered ?? {}).sort()).toEqual([
      "definition.json",
      "environment/Dockerfile",
      "environment/root-setup.sh",
      "environment/setup.sh",
      "environment/smoke.sh",
      "instruction.md",
      "solution/solve.sh",
      "task.toml",
      "tests/Dockerfile",
      "tests/root-setup.sh",
      "tests/setup.sh",
      "tests/smoke.sh",
      "tests/task-test.sh",
      "tests/test.sh",
    ]);
    expect(result.rendered?.["environment/Dockerfile"]).toContain(
      'ENV SECRET_KEY="selfbench-local-secret"',
    );
  });

  test("fails a contract whose SECRET_KEY looks like real key material", () => {
    const result = check({
      environment: {
        ...definition.environment,
        environmentVariables: { SECRET_KEY: "9f2a7c41d3e8b56f0a1c4d7e2b9f8a6c3d5e1f7a9b2c4d6e" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { gate: "policy", message: expect.stringContaining("SECRET_KEY looks like a secret") },
    ]);
  });

  test("rejects an over-tier definition at submit time", () => {
    const result = check({ difficulty: "hard" });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.gate)).toEqual(["audit", "audit", "audit"]);
    expect(result.errors[0]?.message).toContain(
      "hard mode requires at least 3 implementation files",
    );
  });

  test("reports schema, patch, and path problems with their gates", () => {
    expect(check({ testCommand: "bun test" }).errors).toEqual([
      { gate: "schema", message: expect.stringContaining('"{tests}" exactly once') },
    ]);
    expect(check({}, { testPatch: "not a patch", goldPatch }).errors).toEqual([
      { gate: "patches", message: "test patch must be a Git patch starting with diff --git" },
      { gate: "patches", message: "test patch is missing its final newline" },
    ]);
    expect(check({}, { testPatch: testPatch.replaceAll("\n", "\r\n"), goldPatch }).errors).toEqual([
      { gate: "patches", message: "test patch has CRLF line endings; write it with LF only" },
    ]);
    expect(
      check(
        {},
        { testPatch: testPatch.replaceAll("tests/feature.test.ts", "../escape.ts"), goldPatch },
      ).errors,
    ).toEqual([{ gate: "paths", message: expect.stringContaining("escapes repository") }]);
    expect(staticCheckSubmission({ definitionJson: "{", testPatch, goldPatch }).errors).toEqual([
      { gate: "schema", message: expect.stringContaining("not valid JSON") },
    ]);
  });

  test("enforces the fix boundary when an original task is supplied", () => {
    const result = staticCheckSubmission({
      definitionJson: JSON.stringify({ ...definition, prompt: "changed" }),
      testPatch,
      goldPatch,
      original: { definitionJson: JSON.stringify(definition), testPatch, goldPatch },
    });
    expect(result.errors).toEqual([
      { gate: "fix", message: "verifier fix changed immutable definition field prompt" },
    ]);
  });

  test("the sandbox-check program proves patches apply against a clean base worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-check-apply-"));
    try {
      const repo = join(root, "repo");
      await runCommand("git", ["init", "-q", repo]);
      await runCommand("git", ["-C", repo, "config", "user.email", "t@example.com"]);
      await runCommand("git", ["-C", repo, "config", "user.name", "T"]);
      await writeFile(join(repo, "keep.txt"), "base\n");
      await runCommand("git", ["-C", repo, "add", "."]);
      await runCommand("git", ["-C", repo, "commit", "-qm", "base"]);
      await Promise.all([
        writeFile(join(root, "definition.json"), JSON.stringify(definition)),
        writeFile(join(root, "test.patch"), testPatch),
        writeFile(
          join(root, "gold.patch"),
          goldPatch.replace("@@ -0,0 +1,25 @@", "@@ -0,0 +1,30 @@"),
        ),
      ]);
      const result = await runCommand("bun", [
        "run",
        "src/sandbox/programs/check.ts",
        join(root, "definition.json"),
        join(root, "test.patch"),
        join(root, "gold.patch"),
        root,
        "--repository",
        repo,
        "--base",
        "HEAD",
      ]);
      const verdict = JSON.parse(result.stdout) as {
        ok: boolean;
        errors: { gate: string; message: string }[];
      };
      expect(verdict.ok).toBe(false);
      expect(verdict.errors).toEqual([
        {
          gate: "patch",
          message: expect.stringContaining("gold.patch does not apply to the clean base tree"),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the sandbox-check program prints a verdict and writes the rendered tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-check-"));
    try {
      await Promise.all([
        writeFile(join(root, "definition.json"), JSON.stringify(definition)),
        writeFile(join(root, "test.patch"), testPatch),
        writeFile(join(root, "gold.patch"), goldPatch),
      ]);
      const result = await runCommand("bun", [
        "run",
        "src/sandbox/programs/check.ts",
        join(root, "definition.json"),
        join(root, "test.patch"),
        join(root, "gold.patch"),
        root,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        errors: [],
        renderedDirectory: join(root, "rendered"),
      });
      expect(await readFile(join(root, "rendered/task.toml"), "utf8")).toContain(
        'name = "selfbench/static-check"',
      );
      expect(await readFile(join(root, "rendered/tests/test.sh"), "utf8")).toContain(
        "fail_to_pass",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
