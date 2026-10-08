import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  baseCommit,
  diffLine,
  fileKind,
  fileSize,
  isSnapshot,
  laidOut,
  snapshotCommand,
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
  const button = useRef<HTMLButtonElement>(null);
  // In a list too short to show every file, the chosen one scrolls into view.
  useEffect(() => {
    if (chosen) button.current?.scrollIntoView({ block: "nearest" });
  }, [chosen]);
  return (
    <button
      ref={button}
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

/** The chosen file, named in a bar above it. */
export function FilePane({
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
  return (
    <>
      <p className="flex shrink-0 items-baseline gap-2 border-b border-border px-4 py-1.5 font-mono text-xs">
        <span className="min-w-0 wrap-anywhere">{file.path}</span>
        <span className="shrink-0 text-muted-foreground">{fileSize(file.sizeBytes)}</span>
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        <FileView file={file} files={files} repository={repository} taskId={taskId} />
      </div>
    </>
  );
}

/** A file's contents: its lines numbered, a diff in colour, or why it is not shown. */
function FileView({
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
      <div className="flex flex-col gap-3 p-4">
        <p className="max-w-3xl">
          The repository{commit ? ` at ${commit.slice(0, 12)}` : ""}, as the task builds from it (
          {fileSize(file.sizeBytes)}). Both of its copies, in environment/ and tests/, are left out
          of the download; this command, run where you unpacked it, recreates them exactly.
        </p>
        {commit && <Command text={snapshotCommand(repository, commit, taskId)} />}
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

/**
 * A command to paste into a shell, wrapped to fit, each wrapped line indented under the one it
 * continues, with a button in its corner that copies it whole. Where the clipboard is out of
 * reach, the button selects it instead, for the keyboard to copy.
 */
function Command({ text }: { text: string }) {
  const block = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const shown = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(shown);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      if (block.current) window.getSelection()?.selectAllChildren(block.current);
    }
  };
  return (
    <div className="relative">
      <pre
        ref={block}
        className="bg-muted py-3 pr-11 pl-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere"
      >
        {text.split("\n").map((line, number) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a command's lines are known by position
          <span key={number} className="block pl-[4ch] -indent-[4ch]">
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy Command"}
        title={copied ? "Copied" : "Copy Command"}
        onClick={() => void copy()}
        className="hit absolute top-1.5 right-1.5 p-1.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
