import { cp, lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { runCommand } from "../../lib/process.js";

/**
 * A scenario task has no repository behind it: its author writes the agent's starting files in
 * `workspace/`, beside the rest of the submission. That directory plays the part a pull request's
 * base commit plays for every other task: it is the snapshot both images unpack into /app, and the
 * tree both patches apply to.
 */
export const WORKSPACE_DIRECTORY = "workspace";

/** Large enough for a mailbox and a few spreadsheets, small enough to ship with every trial. */
const MAX_WORKSPACE_BYTES = 50 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 5_000;

/** Why the workspace at `directory` can't be a task's snapshot; empty when it can. */
export async function workspaceProblems(directory: string): Promise<string[]> {
  const stats = await lstat(directory).catch(() => undefined);
  if (!stats?.isDirectory()) {
    return [
      `${WORKSPACE_DIRECTORY}/ is missing: write the files the agent starts with in /work/task/${WORKSPACE_DIRECTORY}/`,
    ];
  }
  const problems: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const shown = `${WORKSPACE_DIRECTORY}/${relative(directory, path)}`;
      if (entry.name === ".git") {
        problems.push(
          `${shown} must not exist: make the patches in a copy of ${WORKSPACE_DIRECTORY}/, not in it`,
        );
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await lstat(path)).size;
      } else {
        problems.push(`${shown} is not a regular file or directory`);
      }
    }
  };
  await walk(directory);
  if (files === 0) problems.push(`${WORKSPACE_DIRECTORY}/ holds no files`);
  if (files > MAX_WORKSPACE_FILES)
    problems.push(`${WORKSPACE_DIRECTORY}/ holds ${files} files; at most ${MAX_WORKSPACE_FILES}`);
  if (bytes > MAX_WORKSPACE_BYTES)
    problems.push(
      `${WORKSPACE_DIRECTORY}/ holds ${Math.ceil(bytes / 1024 / 1024)} MB; at most ${MAX_WORKSPACE_BYTES / 1024 / 1024} MB`,
    );
  return problems;
}

/**
 * Commits a copy of the workspace as a Git repository at `destination`, so the patches can be
 * proven against it as a pull request's are against its base commit, and its snapshot made with
 * `git archive` as a repository's is. Fixed dates make the same files the same commit. Returns it.
 */
export async function workspaceRepository(
  workspace: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
  };
  const git = (...args: string[]) =>
    runCommand(
      "git",
      ["-C", destination, "-c", "user.email=selfbench@local", "-c", "user.name=selfbench", ...args],
      { env, ...(signal ? { signal } : {}) },
    );
  await cp(workspace, destination, { recursive: true });
  await git("init", "-q");
  // Forced, so a .gitignore among the author's files never leaves one out of the snapshot.
  await git("add", "-A", "-f");
  await git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "workspace", "--no-verify");
  return (await git("rev-parse", "HEAD")).stdout.trim();
}
