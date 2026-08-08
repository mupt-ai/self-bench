import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileHarborTask, goldPatchChangesDependencyManifests } from "../src/harbor-task.js";
import { runCommand } from "../src/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Harbor task compiler", () => {
  test("builds a sealed native Harbor bundle from a pinned commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-compiler-"));
    roots.push(root);
    const repo = join(root, "repo");
    const authored = join(root, "authored");
    const output = join(root, "output");
    await Promise.all([mkdir(repo), mkdir(authored)]);
    await runCommand("git", ["init", "-q", repo]);
    await runCommand("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await runCommand("git", ["-C", repo, "config", "user.name", "Test"]);
    await mkdir(join(repo, "project"));
    await writeFile(join(repo, "value.txt"), "base\n");
    await writeFile(join(repo, "project/package.json"), '{"dependencies":{"left-pad":"1.0.0"}}\n');
    await runCommand("git", ["-C", repo, "add", "."]);
    await runCommand("git", ["-C", repo, "commit", "-qm", "base"]);
    const commit = (await runCommand("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      join(authored, "definition.json"),
      JSON.stringify({
        schemaVersion: 1,
        difficulty: "medium",
        taskId: "example",
        repo: "example/repo",
        baseCommit: commit,
        workdir: "project",
        setupCommand: "npm ci --ignore-scripts",
        testCommand: "test {tests} && test {tests}",
        failToPass: ["tests/new"],
        passToPass: ["tests/a", "tests/b"],
        testPaths: ["tests/new"],
        toolchains: ["bun"],
        sourcePr: 1,
        sourceUrl: "https://github.com/example/repo/pull/1",
        prompt: "Implement the requested behavior.",
        timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
        resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
      }),
    );
    await writeFile(
      join(authored, "test.patch"),
      "diff --git a/tests/new b/tests/new\nnew file mode 100644\n--- /dev/null\n+++ b/tests/new\n@@ -0,0 +1 @@\n+test\n",
    );
    await writeFile(
      join(authored, "gold.patch"),
      'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-base\n+fixed\ndiff --git a/project/package.json b/project/package.json\n--- a/project/package.json\n+++ b/project/package.json\n@@ -1 +1 @@\n-{"dependencies":{"left-pad":"1.0.0"}}\n+{"dependencies":{"left-pad":"1.1.0"}}\n',
    );

    await compileHarborTask(authored, repo, output);

    expect(await readFile(join(output, "instruction.md"), "utf8")).toBe(
      "Implement the requested behavior.\n",
    );
    const taskToml = await readFile(join(output, "task.toml"), "utf8");
    expect(taskToml).toContain('difficulty = "medium"');
    expect(taskToml).toContain('"medium"');
    expect(taskToml).toContain(
      'allowed_hosts = ["chatgpt.com", "*.chatgpt.com", "openai.com", "*.openai.com"]',
    );
    expect(await readFile(join(output, "environment/Dockerfile"), "utf8")).not.toContain(
      "gold.patch",
    );
    const verifierDockerfile = await readFile(join(output, "tests/Dockerfile"), "utf8");
    expect(verifierDockerfile).toContain("COPY dependency-setup.patch");
    expect(verifierDockerfile).toContain("npm ci --ignore-scripts");
    expect(verifierDockerfile).toContain("git -C /app reset --hard -q HEAD");
    expect(verifierDockerfile).toContain("COPY test.patch test.sh /tests/");
    const dependencyPatch = await readFile(join(output, "tests/dependency-setup.patch"), "utf8");
    expect(dependencyPatch).toContain('left-pad":"1.1.0');
    expect(dependencyPatch).not.toContain("value.txt");
    const verifier = await readFile(join(output, "tests/test.sh"), "utf8");
    expect(verifier).toContain("deterministic");
    expect(verifier).not.toContain("npm ci --ignore-scripts");
    expect(verifier).toContain("/app/project/tests/new");
    expect(verifier).not.toContain("{tests}");
    expect(verifier).toContain('"fail_to_pass_exit_code": $fail_to_pass_exit_code');
    expect(verifier).toContain('PATH="/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin');
    const dockerfile = await readFile(join(output, "environment/Dockerfile"), "utf8");
    expect(dockerfile).toContain("UV_CACHE_DIR=/opt/uv-cache");
    expect(dockerfile.indexOf("nodejs.org/dist")).toBeLessThan(
      dockerfile.indexOf("npm install --global bun"),
    );
    expect(dockerfile).toContain("&& corepack enable");
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/playwright");
    expect(
      JSON.parse(await readFile(join(output, ".selfbench-manifest.json"), "utf8")).compilerRevision,
    ).toBe(19);
  });

  test("detects supported dependency manifests without treating source changes as dependencies", () => {
    expect(
      goldPatchChangesDependencyManifests(
        "diff --git a/apps/api/pyproject.toml b/apps/api/pyproject.toml\n",
      ),
    ).toBe(true);
    expect(
      goldPatchChangesDependencyManifests(
        "diff --git a/src/package-handler.ts b/src/package-handler.ts\n",
      ),
    ).toBe(false);
  });
});
