import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../../lib/hash.js";
import { COMPILER_REVISION, HARBOR_SCHEMA_VERSION } from "./constants.js";
import { agentDockerfile, type TaskIdentity, taskToml, verifierDockerfile } from "./render.js";
import { verifierRuntimeFiles } from "./runtime-assets.js";
import { SUBMISSION_FILES, type Submission } from "./submission.js";
import { solutionScript, testScript } from "./verifier.js";

/**
 * Renders a checked submission (checkSubmission, its base images pinned) as a Harbor task over
 * `snapshot`, the repository at the task's base commit as `git archive` makes it. Both image
 * contexts get the snapshot as repo.tar.gz; only the verifier's holds the hidden tests, and
 * neither holds the solution. A task without services gets an empty services.sh, so both images
 * are built the same way.
 */
export async function compileHarborTask(
  submission: Submission,
  task: TaskIdentity,
  snapshot: string,
  outputDirectory: string,
): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true });
  const environment = join(outputDirectory, "environment");
  const solution = join(outputDirectory, "solution");
  const tests = join(outputDirectory, "tests");
  await Promise.all([
    mkdir(environment, { recursive: true }),
    mkdir(solution, { recursive: true }),
    mkdir(join(tests, "runtime"), { recursive: true }),
  ]);

  await Promise.all([
    cp(snapshot, join(environment, "repo.tar.gz")),
    cp(snapshot, join(tests, "repo.tar.gz")),
    writeFile(join(outputDirectory, "instruction.md"), `${submission["instruction.md"].trim()}\n`),
    writeFile(join(outputDirectory, "task.toml"), taskToml(task)),
    writeFile(join(environment, "Dockerfile"), agentDockerfile(submission.Dockerfile)),
    writeFile(join(environment, "smoke.sh"), submission["smoke.sh"]),
    writeFile(join(environment, "services.sh"), submission["services.sh"]),
    writeFile(join(tests, "Dockerfile"), verifierDockerfile(submission.Dockerfile)),
    writeFile(join(tests, "test.sh"), testScript(submission["test.patch"])),
    writeFile(join(tests, "test.patch"), submission["test.patch"]),
    writeFile(join(tests, "run-tests.sh"), submission["run-tests.sh"]),
    writeFile(join(tests, "services.sh"), submission["services.sh"]),
    ...Object.entries(verifierRuntimeFiles()).map(([path, content]) =>
      writeFile(join(tests, path), content),
    ),
    writeFile(join(solution, "gold.patch"), submission["gold.patch"]),
    writeFile(join(solution, "solve.sh"), solutionScript()),
  ]);
  await Promise.all([
    chmod(join(solution, "solve.sh"), 0o755),
    chmod(join(tests, "test.sh"), 0o755),
    chmod(join(environment, "smoke.sh"), 0o755),
  ]);
  await writeFile(
    join(outputDirectory, ".selfbench-manifest.json"),
    `${JSON.stringify(
      {
        generator: "selfbench",
        harborSchemaVersion: HARBOR_SCHEMA_VERSION,
        compilerRevision: COMPILER_REVISION,
        taskId: task.taskId,
        difficulty: task.difficulty,
        submissionSha256: Object.fromEntries(
          SUBMISSION_FILES.map((name) => [name, sha256(submission[name])]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}
