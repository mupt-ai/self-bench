import type { PublicTaskFiles } from "./contract";

/** One file of a published task, as the viewer lists it. */
export type TaskFile = PublicTaskFiles["files"][number];

/** The two copies of the repository a compiled task builds from; never in a download. */
const SNAPSHOTS = new Set(["environment/repo.tar.gz", "tests/repo.tar.gz"]);

/** Whether `path` is one of the task's repository snapshots. */
export const isSnapshot = (path: string) => SNAPSHOTS.has(path);

/** The commit the task starts from, as its `task.toml` names it. */
export function baseCommit(files: readonly TaskFile[]): string | undefined {
  const config = files.find((file) => file.path === "task.toml")?.text ?? "";
  return /^base_commit\s*=\s*"([0-9a-f]{7,64})"/m.exec(config)?.[1];
}

/** A path as a shell reads it: quoted unless it is only letters, digits, and `._/-`. */
const shellPath = (path: string) => (/^[\w./-]+$/.test(path) ? path : `'${path}'`);

/**
 * One command that rebuilds both repository snapshots a download leaves out, run in the folder
 * the download unpacks to. Each snapshot is `git archive` of the repository at the task's base
 * commit, so this gives the same files; one shallow fetch of that commit is all it needs, into a
 * scratch repository inside the task that it removes at the end. Its steps are joined with `&&`
 * on continued lines, so pasting the whole of it runs it, and it stops at the first that fails.
 */
export function snapshotCommand(repository: string, commit: string, folder: string): string {
  const scratch = shellPath(`${folder}/.snapshot`);
  return [
    `git init -q ${scratch}`,
    `git -C ${scratch} fetch -q --depth 1 https://github.com/${repository} ${commit}`,
    `git -C ${scratch} archive --format=tar.gz -o "$PWD/${folder}/environment/repo.tar.gz" FETCH_HEAD`,
    `cp ${shellPath(`${folder}/environment/repo.tar.gz`)} ${shellPath(`${folder}/tests/repo.tar.gz`)}`,
    `rm -rf ${scratch}`,
  ].join(" && \\\n  ");
}
