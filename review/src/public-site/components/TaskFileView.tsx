import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FileViewer } from "../../components/FileViewer";
import { formatBytes } from "../../lib/format";
import { baseCommit, isSnapshot, shownText, snapshotCommand, type TaskFile } from "../task-files";

/**
 * The chosen file, in the app's file viewer, with the task's canary in a bar below it, so every
 * file shown has it beside it: the patches and JSON, which do not carry it, and the instruction,
 * shown without the copy it opens with. The canary keeps to one line; its full text is still in
 * the page.
 */
export function FilePane({
  file,
  files,
  repository,
  taskId,
  canary,
}: {
  file: TaskFile;
  files: readonly TaskFile[];
  repository: string;
  taskId: string;
  canary?: string | undefined;
}) {
  return (
    <FileViewer
      file={file.text === undefined ? file : { ...file, text: shownText(file, canary) }}
      binary={<NotShown file={file} files={files} repository={repository} taskId={taskId} />}
      footer={
        canary && (
          <p
            title={canary}
            className="shrink-0 truncate border-t border-border px-4 py-1.5 font-mono text-[11px] text-(--faint)"
          >
            {canary}
          </p>
        )
      }
    />
  );
}

/** Why a file without text is not shown: a repository snapshot, with how to rebuild it, or not. */
function NotShown({
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
  if (!isSnapshot(file.path))
    return (
      <p className="px-4 py-3 text-muted-foreground">
        Not shown here: a binary or large file ({formatBytes(file.sizeBytes)}). It is in the
        download.
      </p>
    );
  const commit = baseCommit(files);
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <p className="max-w-3xl">
        The repository{commit ? ` at ${commit.slice(0, 12)}` : ""}, as the task builds from it (
        {formatBytes(file.sizeBytes)}). Both of its copies, in environment/ and tests/, are left out
        of the download; this command, run where you unpacked it, recreates them exactly.
      </p>
      {commit && <Command text={snapshotCommand(repository, commit, taskId)} />}
    </div>
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
