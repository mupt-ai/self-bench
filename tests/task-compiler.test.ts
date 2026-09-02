import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/process.js";
import {
  compileEnvironmentTask,
  EnvironmentCompilerInfrastructureError,
} from "../src/temporal/activities/environment-compiler.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("trusted environment compiler rebuilds the sandbox draft against the pinned repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-environment-compiler-"));
  roots.push(root);
  const repository = join(root, "repository");
  const authored = join(root, "authored");
  await Promise.all([mkdir(repository), mkdir(authored)]);
  await runCommand("git", ["init", "-q", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Test"]);
  await writeFile(join(repository, "package.json"), '{"scripts":{"test":"true"}}\n');
  await writeFile(join(repository, "value.txt"), "base\n");
  await runCommand("git", ["-C", repository, "add", "."]);
  await runCommand("git", ["-C", repository, "commit", "-qm", "base"]);
  const commit = (await runCommand("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const definition = {
    schemaVersion: 2,
    difficulty: "easy",
    taskId: "trusted-compile",
    repo: "example/repo",
    baseCommit: commit,
    workdir: ".",
    testCommand: "test {tests}",
    failToPass: ["tests/new.test"],
    passToPass: [],
    testPaths: ["tests/new.test"],
    sourcePr: 1,
    sourceUrl: "https://github.com/example/repo/pull/1",
    prompt: "Implement the behavior.",
    timeouts: { setupSeconds: 60, agentSeconds: 60, testsSeconds: 60 },
    resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
    environment: {
      schemaVersion: 1,
      baseImage: `node:22@sha256:${"a".repeat(64)}`,
      rootSetupCommand: "apt-get update && apt-get install -y bash git passwd procps tar",
      setupCommand: "true",
      smokeCommand: "true",
      environmentVariables: {},
      services: [],
      source: "ci-adapted",
      evidence: [{ path: "package.json", reason: "Defines the test command." }],
    },
  } as const;
  await Promise.all([
    writeFile(join(authored, "definition.json"), JSON.stringify(definition)),
    writeFile(
      join(authored, "test.patch"),
      "diff --git a/tests/new.test b/tests/new.test\nnew file mode 100644\n--- /dev/null\n+++ b/tests/new.test\n@@ -0,0 +1 @@\n+test\n",
    ),
    writeFile(
      join(authored, "gold.patch"),
      "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-base\n+fixed\n",
    ),
  ]);
  const sourceArchive = join(root, "source.tar.gz");
  await runCommand("tar", ["-czf", sourceArchive, "-C", authored, "."]);

  const bundle = await compileEnvironmentTask(
    {
      taskId: definition.taskId,
      repositoryUrl: "https://github.com/example/repo.git",
      definitionBytes: Buffer.from(JSON.stringify(definition)),
      sourceBundle: await readFile(sourceArchive),
    },
    {
      cloneRepository: async (_url, requestedCommit, destination) => {
        expect(requestedCommit).toBe(commit);
        await cp(repository, destination, { recursive: true });
      },
    },
  );
  const output = join(root, "output.tar.gz");
  await writeFile(output, bundle);
  const listing = await runCommand("tar", ["-tzf", output]);

  expect(listing.stdout).toContain("harbor-task/.selfbench-manifest.json");
  expect(listing.stdout).toContain("harbor-task/environment/repo.tar.gz");
});

test("trusted environment compiler classifies repository failures as infrastructure", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-environment-compiler-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  const archive = join(root, "source.tar.gz");
  await writeFile(join(source, "definition.json"), "{}");
  await runCommand("tar", ["-czf", archive, "-C", source, "."]);
  const definition = {
    schemaVersion: 2,
    difficulty: "easy",
    taskId: "clone-failure",
    repo: "example/repo",
    baseCommit: "a".repeat(40),
    workdir: ".",
    testCommand: "test {tests}",
    failToPass: ["tests/new.test"],
    passToPass: [],
    testPaths: ["tests/new.test"],
    sourcePr: 1,
    sourceUrl: "https://github.com/example/repo/pull/1",
    prompt: "Implement the behavior.",
    timeouts: { setupSeconds: 60, agentSeconds: 60, testsSeconds: 60 },
    resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
    environment: {
      schemaVersion: 1,
      baseImage: `node:22@sha256:${"a".repeat(64)}`,
      rootSetupCommand: "true",
      setupCommand: "true",
      smokeCommand: "true",
      environmentVariables: {},
      services: [],
      source: "generated",
      evidence: [{ path: "package.json", reason: "test" }],
    },
  } as const;

  await expect(
    compileEnvironmentTask(
      {
        taskId: definition.taskId,
        repositoryUrl: "https://github.com/example/repo.git",
        definitionBytes: Buffer.from(JSON.stringify(definition)),
        sourceBundle: await readFile(archive),
      },
      { cloneRepository: async () => Promise.reject(new Error("network down")) },
    ),
  ).rejects.toBeInstanceOf(EnvironmentCompilerInfrastructureError);
});
