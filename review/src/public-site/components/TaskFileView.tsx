import { useState } from "react";
import {
  baseCommit,
  diffLine,
  fileKind,
  fileSize,
  isSnapshot,
  laidOut,
  snapshotCommands,
  type TaskFile,
} from "../task-files";

/** A file in the list: its folder dimmed, its name, its size. */
export function FileButton({
  file,
  chosen,
  onChoose,
}: {
  file: TaskFile;
  chosen: boolean;
  onChoose(): void;
}) {
  const slash = file.path.lastIndexOf("/");
  return (
    <button
      type="button"
      aria-current={chosen ? "true" : undefined}
      onClick={onChoose}
      className="flex w-full items-baseline gap-2 px-4 py-1.5 text-left font-mono text-xs hover:bg-muted aria-[current=true]:bg-muted touch:py-3.5"
    >
      <span
        className={`min-w-0 flex-1 wrap-anywhere ${file.text === undefined ? "text-muted-foreground" : ""}`}
      >
        {slash >= 0 && (
          <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
        )}
        {file.path.slice(slash + 1)}
      </span>
      <span className="shrink-0 text-muted-foreground">{fileSize(file.sizeBytes)}</span>
    </button>
  );
}

/** The chosen file: its lines numbered, a diff in colour, or why it is not shown. */
export function FileView({
  file,
  files,
  repository,
  taskId,
}: {
  file: TaskFile;
  files: readonly TaskFile[];
  repository: string;
  taskId: string;
}) {
  const kind = fileKind(file);
  if (kind === "none") {
    const commit = baseCommit(files);
    return isSnapshot(file.path) ? (
      <div className="flex max-w-3xl flex-col gap-3 p-4">
        <p>
          The repository{commit ? ` at ${commit.slice(0, 12)}` : ""}, as the task builds from it (
          {fileSize(file.sizeBytes)}). It is left out of the download; these commands, run where you
          unpacked it, recreate it exactly.
        </p>
        {commit && <Commands text={snapshotCommands(repository, commit, taskId)} />}
      </div>
    ) : (
      <p className="p-4 text-muted-foreground">
        Not shown here: a binary or large file ({fileSize(file.sizeBytes)}). It is in the download.
      </p>
    );
  }
  const text = kind === "json" ? laidOut(file.text ?? "") : (file.text ?? "");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return (
    <pre
      className={`task-lines py-2 font-mono text-xs leading-relaxed ${file.path.endsWith(".md") ? "task-lines-wrap" : ""}`}
    >
      {lines.map((line, number) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines are numbered by position
          key={number}
          className={kind === "diff" ? `task-diff-${diffLine(line)}` : undefined}
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** Commands to paste into a shell, with a button that copies them. */
function Commands({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      <pre className="w-full overflow-x-auto bg-muted p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => undefined,
          )
        }
        className="hit relative text-sm font-medium underline underline-offset-4"
      >
        {copied ? "Copied" : "Copy Commands"}
      </button>
    </div>
  );
}
