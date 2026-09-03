import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileHarborTask,
  goldPatchChangesDependencyManifests,
  refreshHarborTask,
} from "../src/harbor-task.js";
import { sha256 } from "../src/hash.js";
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
        schemaVersion: 2,
        difficulty: "medium",
        taskId: "example",
        repo: "example/repo",
        baseCommit: commit,
        workdir: "project",
        testCommand: "test {tests}",
        failToPass: ["tests/new"],
        passToPass: ["tests/a", "tests/b"],
        testPaths: ["tests/new"],
        environment: {
          schemaVersion: 1,
          baseImage: `node:22-bookworm@sha256:${"a".repeat(64)}`,
          rootSetupCommand:
            "apt-get update && apt-get install -y --no-install-recommends bash git passwd procps tar",
          setupCommand: "npm ci --ignore-scripts",
          smokeCommand: "npm --version",
          environmentVariables: { PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright" },
          services: [
            {
              name: "redis",
              image: `redis:7@sha256:${"b".repeat(64)}`,
              environmentVariables: {},
              healthcheck: {
                test: ["CMD", "redis-cli", "ping"],
                intervalSeconds: 2,
                timeoutSeconds: 1,
                retries: 10,
                startPeriodSeconds: 0,
              },
            },
          ],
          source: "ci-adapted",
          evidence: [{ path: "project/package.json", reason: "Defines dependencies." }],
        },
        sourcePr: 1,
        sourceUrl: "https://github.com/example/repo/pull/1",
        prompt: "Implement the requested behavior.",
        timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
        resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
      }),
    );
    await writeFile(
      join(authored, "test.patch"),
      "diff --git a/project/tests/new b/project/tests/new\nnew file mode 100644\n--- /dev/null\n+++ b/project/tests/new\n@@ -0,0 +1 @@\n+test\ndiff --git a/project/fixture.config.js b/project/fixture.config.js\nnew file mode 100644\n--- /dev/null\n+++ b/project/fixture.config.js\n@@ -0,0 +1 @@\n+export default {}\n",
    );
    await writeFile(
      join(authored, "gold.patch"),
      'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-base\n+fixed\ndiff --git a/project/package.json b/project/package.json\n--- a/project/package.json\n+++ b/project/package.json\n@@ -1 +1 @@\n-{"dependencies":{"left-pad":"1.0.0"}}\n+{"dependencies":{"left-pad":"1.1.0"}}\n',
    );

    await compileHarborTask(authored, repo, output);

    expect(await readFile(join(output, "instruction.md"), "utf8")).toBe(
      "Implement the requested behavior.\n",
    );
    expect(JSON.parse(await readFile(join(output, "definition.json"), "utf8"))).toMatchObject({
      taskId: "example",
      difficulty: "medium",
    });
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
    expect(verifierDockerfile).toContain("FROM node:22-bookworm@sha256:");
    expect(verifierDockerfile).toContain("COPY root-setup.sh");
    expect(verifierDockerfile).not.toContain("npm ci --ignore-scripts");
    expect(verifierDockerfile).toContain("git -C /app reset --hard -q HEAD");
    expect(verifierDockerfile).toContain("COPY test.patch test.sh task-test.sh /tests/");
    const dependencyPatch = await readFile(join(output, "tests/dependency-setup.patch"), "utf8");
    expect(dependencyPatch).toContain('left-pad":"1.1.0');
    expect(dependencyPatch).not.toContain("value.txt");
    const verifier = await readFile(join(output, "tests/test.sh"), "utf8");
    expect(verifier).toContain("deterministic");
    expect(verifier).toContain("selfbench-verifier-command");
    expect(verifier).toContain("ECONNRESET|ETIMEDOUT");
    expect(verifier).not.toContain("npm ci --ignore-scripts");
    expect(verifier).toContain("/app/project/tests/new");
    expect(verifier).toContain("/app/project/fixture.config.js");
    expect(verifier).toContain("--exclude='project/fixture.config.js'");
    expect(verifier).toContain(
      "for protected_path in 'project/fixture.config.js' 'project/tests/new'; do",
    );
    expect(verifier).not.toContain("{tests}");
    expect(verifier).toContain('"fail_to_pass_exit_code": $fail_to_pass_exit_code');
    expect(verifier).toContain(
      'runuser -u verifier --preserve-environment -- env -u XDG_CACHE_HOME HOME=/home/verifier bash -c "$1"',
    );
    expect(verifier).not.toMatch(/runuser[^\n]*--preserve-environment -- bash/);
    expect(verifierDockerfile).toContain("useradd --create-home --shell /bin/bash verifier");
    expect(verifierDockerfile).toContain("chown -R verifier:verifier /app /home/verifier");
    const dockerfile = await readFile(join(output, "environment/Dockerfile"), "utf8");
    expect(dockerfile).toContain('ENV PLAYWRIGHT_BROWSERS_PATH="/opt/playwright"');
    expect(await readFile(join(output, "environment/setup.sh"), "utf8")).toContain(
      "npm ci --ignore-scripts",
    );
    expect(await readFile(join(output, "tests/smoke.sh"), "utf8")).toContain("npm --version");
    expect(await Bun.file(join(output, "environment/docker-compose.yaml")).exists()).toBe(false);
    const compose = JSON.parse(await readFile(join(output, "tests/docker-compose.yaml"), "utf8"));
    expect(compose.services.main.depends_on.redis.condition).toBe("service_healthy");
    expect(compose.services.redis.image).toContain("redis:7@sha256:");
    expect(
      JSON.parse(await readFile(join(output, ".selfbench-manifest.json"), "utf8")).compilerRevision,
    ).toBe(26);

    const repairedDefinition = {
      ...JSON.parse(await readFile(join(authored, "definition.json"), "utf8")),
      testCommand: "test --repaired {tests}",
    };
    const repairedPatch =
      "diff --git a/tests/new b/tests/new\nnew file mode 100644\n--- /dev/null\n+++ b/tests/new\n@@ -0,0 +1 @@\n+repaired\n";
    await writeFile(join(output, "tests/test.patch"), repairedPatch);
    await refreshHarborTask(output, repairedDefinition);
    const refreshedManifest = JSON.parse(
      await readFile(join(output, ".selfbench-manifest.json"), "utf8"),
    );
    expect(refreshedManifest.definitionSha256).toBe(sha256(JSON.stringify(repairedDefinition)));
    expect(refreshedManifest.testPatchSha256).toBe(sha256(repairedPatch));
    expect(await readFile(join(output, "tests/test.sh"), "utf8")).toContain("--repaired");
    expect(JSON.parse(await readFile(join(output, "definition.json"), "utf8"))).toMatchObject({
      taskId: "example",
      testCommand: "test --repaired {tests}",
    });
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
