import type { PublicTaskFiles } from "./contract";

/** One file of a published task, as the viewer lists it. */
export type TaskFile = PublicTaskFiles["files"][number];

/** The two copies of the repository a compiled task builds from; never in a download. */
const SNAPSHOTS = new Set(["environment/repo.tar.gz", "tests/repo.tar.gz"]);

/** Whether `path` is one of the task's repository snapshots. */
export const isSnapshot = (path: string) => SNAPSHOTS.has(path);

/** The file a task opens on: its instruction, else its config, else its first readable file. */
export function firstFile(files: readonly TaskFile[]): TaskFile | undefined {
  for (const path of ["instruction.md", "task.toml", "definition.json"]) {
    const found = files.find((file) => file.path === path && file.text !== undefined);
    if (found) return found;
  }
  return files.find((file) => file.text !== undefined) ?? files[0];
}

/** How a file's text is shown: a diff in colour, JSON laid out, other text as it is. */
export function fileKind(file: TaskFile): "diff" | "json" | "text" | "none" {
  if (file.text === undefined) return "none";
  if (/\.(patch|diff)$/.test(file.path)) return "diff";
  if (file.path.endsWith(".json")) return "json";
  return "text";
}

/**
 * A file's text as the viewer shows it. The instruction opens with the canary in the download
 * (the server's `withCanary`), and is shown without it, as Harbor gives it to an agent; the bar
 * below every file shows the canary instead. Every other file is shown as it is downloaded.
 */
export function shownText(file: TaskFile, canary: string | undefined): string {
  const text = file.text ?? "";
  const opening = `<!-- ${canary} -->\n\n`;
  return canary && file.path === "instruction.md" && text.startsWith(opening)
    ? text.slice(opening.length)
    : text;
}

/** JSON with two-space indents, or the text as it is when it does not parse. */
export function laidOut(text: string): string {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return text;
  }
}

/** What one line of a diff is, for its colour. */
export function diffLine(line: string): "added" | "removed" | "hunk" | "meta" | "context" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git"))
    return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

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

/** A file size, as the file list shows it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
