import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TaskDefinition, taskDefinitionSchema } from "../contracts.js";
import { assertEnvironmentEvidence, assertEnvironmentPolicy } from "../environment.js";
import { sha256 } from "../hash.js";
import { runCommand } from "../process.js";
import { COMPILER_REVISION, HARBOR_SCHEMA_VERSION } from "./constants.js";
import { dependencyManifestPatch } from "./dependencies.js";
import { assertSafePatchPaths, assertSafeTaskPaths } from "./paths.js";
import {
  agentDockerfile,
  environmentContextFiles,
  serviceComposeFiles,
  taskToml,
  verifierDockerfile,
} from "./render.js";
import { solutionScript, testScript } from "./verifier.js";

export interface AuthoredTaskFiles {
  readonly definition: TaskDefinition;
  readonly testPatch: string;
  readonly goldPatch: string;
}

export async function loadAuthoredTask(directory: string): Promise<AuthoredTaskFiles> {
  const definition = taskDefinitionSchema.parse(
    JSON.parse(await readFile(join(directory, "definition.json"), "utf8")),
  );
  assertEnvironmentPolicy(definition.environment);
  assertSafeTaskPaths(definition);
  const [testPatch, goldPatch] = await Promise.all([
    readFile(join(directory, "test.patch"), "utf8"),
    readFile(join(directory, "gold.patch"), "utf8"),
  ]);
  if (!testPatch.startsWith("diff --git ")) {
    throw new Error("test.patch is not a Git patch");
  }
  assertSafePatchPaths(testPatch);
  if (!goldPatch.startsWith("diff --git ")) {
    throw new Error("gold.patch is not a Git patch");
  }
  assertSafePatchPaths(goldPatch, "gold patch");
  return { definition, testPatch, goldPatch };
}

export async function compileHarborTask(
  authoredDirectory: string,
  repositoryDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const task = await loadAuthoredTask(authoredDirectory);
  const dependencySetupPatch = dependencyManifestPatch(task.goldPatch);
  const preinstallGoldDependencies = dependencySetupPatch.length > 0;
  await runCommand("git", [
    "-C",
    repositoryDirectory,
    "cat-file",
    "-e",
    `${task.definition.baseCommit}^{commit}`,
  ]);
  const repositoryFiles = await runCommand("git", [
    "-C",
    repositoryDirectory,
    "ls-tree",
    "-r",
    "--name-only",
    task.definition.baseCommit,
  ]);
  assertEnvironmentEvidence(
    task.definition.environment,
    new Set(repositoryFiles.stdout.split("\n").filter(Boolean)),
  );
  await rm(outputDirectory, { recursive: true, force: true });
  const environment = join(outputDirectory, "environment");
  const solution = join(outputDirectory, "solution");
  const tests = join(outputDirectory, "tests");
  await Promise.all([
    mkdir(environment, { recursive: true }),
    mkdir(solution, { recursive: true }),
    mkdir(tests, { recursive: true }),
  ]);

  const snapshot = join(outputDirectory, ".repo.tar.gz");
  await runCommand("git", [
    "-C",
    repositoryDirectory,
    "archive",
    "--format=tar.gz",
    `--output=${snapshot}`,
    task.definition.baseCommit,
  ]);
  await Promise.all([
    cp(snapshot, join(environment, "repo.tar.gz")),
    cp(snapshot, join(tests, "repo.tar.gz")),
    writeFile(
      join(outputDirectory, "definition.json"),
      `${JSON.stringify(task.definition, null, 2)}\n`,
    ),
    writeFile(join(outputDirectory, "instruction.md"), `${task.definition.prompt.trim()}\n`),
    writeFile(join(solution, "gold.patch"), task.goldPatch),
    writeFile(join(solution, "solve.sh"), solutionScript()),
    writeFile(join(tests, "test.patch"), task.testPatch),
    writeFile(join(tests, "test.sh"), testScript(task.definition, task.testPatch)),
    writeFile(join(tests, "task-test.sh"), testScript(task.definition, task.testPatch)),
    writeFile(join(environment, "Dockerfile"), agentDockerfile(task.definition)),
    writeFile(
      join(tests, "Dockerfile"),
      verifierDockerfile(task.definition, preinstallGoldDependencies),
    ),
    ...environmentContextFiles(environment, task.definition),
    ...environmentContextFiles(tests, task.definition),
    ...serviceComposeFiles(tests, task.definition),
    writeFile(join(outputDirectory, "task.toml"), taskToml(task.definition)),
    ...(preinstallGoldDependencies
      ? [writeFile(join(tests, "dependency-setup.patch"), dependencySetupPatch)]
      : []),
  ]);
  await rm(snapshot);
  await Promise.all([
    chmod(join(solution, "solve.sh"), 0o755),
    chmod(join(tests, "test.sh"), 0o755),
    chmod(join(tests, "task-test.sh"), 0o755),
    chmod(join(environment, "root-setup.sh"), 0o755),
    chmod(join(environment, "setup.sh"), 0o755),
    chmod(join(environment, "smoke.sh"), 0o755),
    chmod(join(tests, "root-setup.sh"), 0o755),
    chmod(join(tests, "setup.sh"), 0o755),
    chmod(join(tests, "smoke.sh"), 0o755),
  ]);
  await writeFile(
    join(outputDirectory, ".selfbench-manifest.json"),
    `${JSON.stringify(
      {
        generator: "selfbench",
        harborSchemaVersion: HARBOR_SCHEMA_VERSION,
        compilerRevision: COMPILER_REVISION,
        taskId: task.definition.taskId,
        difficulty: task.definition.difficulty,
        definitionSha256: sha256(JSON.stringify(task.definition)),
        testPatchSha256: sha256(task.testPatch),
        goldPatchSha256: sha256(task.goldPatch),
        environmentSha256: sha256(JSON.stringify(task.definition.environment)),
      },
      null,
      2,
    )}\n`,
  );
}

export async function refreshHarborTask(
  outputDirectory: string,
  definition: TaskDefinition,
): Promise<void> {
  assertEnvironmentPolicy(definition.environment);
  const manifestPath = join(outputDirectory, ".selfbench-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.taskId !== definition.taskId) {
    throw new Error(`bundle task ${String(manifest.taskId)} does not match ${definition.taskId}`);
  }
  const [goldPatch, testPatch] = await Promise.all([
    readFile(join(outputDirectory, "solution/gold.patch"), "utf8"),
    readFile(join(outputDirectory, "tests/test.patch"), "utf8"),
  ]);
  assertSafePatchPaths(testPatch);
  const dependencySetupPatch = dependencyManifestPatch(goldPatch);
  const preinstallGoldDependencies = dependencySetupPatch.length > 0;
  const verifierScript = testScript(definition, testPatch);
  await Promise.all([
    writeFile(join(outputDirectory, "tests/test.sh"), verifierScript),
    writeFile(join(outputDirectory, "tests/task-test.sh"), verifierScript),
  ]);
  const environment = join(outputDirectory, "environment");
  const tests = join(outputDirectory, "tests");
  await Promise.all([
    writeFile(join(outputDirectory, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`),
    writeFile(join(outputDirectory, "task.toml"), taskToml(definition)),
    writeFile(join(environment, "Dockerfile"), agentDockerfile(definition)),
    writeFile(
      join(tests, "Dockerfile"),
      verifierDockerfile(definition, preinstallGoldDependencies),
    ),
    ...environmentContextFiles(environment, definition),
    ...environmentContextFiles(tests, definition),
    rm(join(environment, "docker-compose.yaml"), { force: true }),
    ...serviceComposeFiles(tests, definition),
    preinstallGoldDependencies
      ? writeFile(join(tests, "dependency-setup.patch"), dependencySetupPatch)
      : rm(join(tests, "dependency-setup.patch"), { force: true }),
    chmod(join(tests, "test.sh"), 0o755),
    chmod(join(tests, "task-test.sh"), 0o755),
  ]);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        compilerRevision: COMPILER_REVISION,
        difficulty: definition.difficulty,
        definitionSha256: sha256(JSON.stringify(definition)),
        testPatchSha256: sha256(testPatch),
        goldPatchSha256: sha256(goldPatch),
        environmentSha256: sha256(JSON.stringify(definition.environment)),
      },
      null,
      2,
    )}\n`,
  );
}
