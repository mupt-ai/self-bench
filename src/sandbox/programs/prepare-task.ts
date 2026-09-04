import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive, REPOSITORY_SNAPSHOT_ARCHIVE_OPTIONS } from "../../archive.js";
import { runCommand } from "../../process.js";

export interface PreparedTaskWorkspace {
  readonly extractedDirectory: string;
  readonly taskDirectory: string;
  readonly repositoryDirectory: string;
}

/**
 * Unpacks a compiled Harbor task bundle and materializes its base repository snapshot as a Git
 * working tree with the held-out test patch applied, so an agent can inspect rendered files and
 * edit tests in place.
 */
export async function prepareTaskWorkspace(
  archivePath: string,
  workDirectory = "/work",
): Promise<PreparedTaskWorkspace> {
  const extractedDirectory = join(workDirectory, "task");
  const repositoryDirectory = join(workDirectory, "repo");
  await Promise.all([mkdir(extractedDirectory, { recursive: true }), mkdir(repositoryDirectory)]);
  await extractRegularArchive(archivePath, extractedDirectory);
  const taskDirectory = await access(join(extractedDirectory, "instruction.md")).then(
    () => extractedDirectory,
    () => join(extractedDirectory, "harbor-task"),
  );

  await extractRegularArchive(
    join(taskDirectory, "tests/repo.tar.gz"),
    repositoryDirectory,
    REPOSITORY_SNAPSHOT_ARCHIVE_OPTIONS,
  );
  await runCommand("git", ["-C", repositoryDirectory, "init", "-q"]);
  await runCommand("git", ["-C", repositoryDirectory, "config", "user.name", "SelfBench"]);
  await runCommand("git", ["-C", repositoryDirectory, "config", "user.email", "selfbench@local"]);
  await runCommand("git", ["-C", repositoryDirectory, "add", "-A"]);
  await runCommand("git", ["-C", repositoryDirectory, "commit", "-qm", "base"]);
  await runCommand("git", [
    "-C",
    repositoryDirectory,
    "apply",
    join(taskDirectory, "tests/test.patch"),
  ]);
  await runCommand("git", ["-C", repositoryDirectory, "add", "-N", "--all"]);

  return { extractedDirectory, taskDirectory, repositoryDirectory };
}
