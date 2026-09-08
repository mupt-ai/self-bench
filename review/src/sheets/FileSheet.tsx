import React from "react";
import { DiffView } from "../components/DiffView";
import { Block, Script } from "../components/Script";
import { loading, notice, sheetBody, viewerButton, viewerLink } from "../components/viewer-ui";
import { formatBytes } from "../lib/format";
import { fileKind } from "../lib/task-model";

export interface OpenFile {
  path: string;
  sizeBytes?: number;
  text?: string;
  loading?: boolean;
  error?: string;
  /** Present when only the end of a large log was fetched. */
  tail?: { shownBytes: number; loadFull: () => void };
}

export function FileSheet({ file }: { file: OpenFile | null }) {
  const [fullscreen, setFullscreen] = React.useState(false);
  React.useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  if (!file) return <p className={notice}>Select a file to inspect.</p>;
  if (file.loading) return <p className={loading}>reading {file.path}</p>;
  if (file.error)
    return <p className={`${notice} !text-(--bad-fg) site:!text-danger`}>{file.error}</p>;
  const size = file.sizeBytes ?? file.text?.length ?? 0;
  if (file.text === undefined) {
    return (
      <div className={sheetBody}>
        <Block title="Binary File" detail={file.path}>
          <p className="px-4 py-3 text-(--muted-fg)">
            {formatBytes(size)} · not shown inline. Repository snapshots and archives stay on the
            server.
          </p>
        </Block>
      </div>
    );
  }
  const kind = fileKind(file.path);
  const stats = file.tail
    ? `last ${formatBytes(file.tail.shownBytes)} of ${formatBytes(size)}`
    : `${formatBytes(size)} · ${file.text.split("\n").length} lines`;
  const body =
    kind === "patch" ? (
      <DiffView patch={file.text} />
    ) : kind === "json" ? (
      <Script text={prettyJson(file.text)} />
    ) : (
      <Script text={file.text} wrap={kind === "text"} />
    );
  if (fullscreen) {
    return (
      <div
        className="fixed inset-0 z-50 grid grid-rows-[auto_minmax(0,1fr)] bg-(--background) site:z-30"
        role="dialog"
        aria-label={`${file.path} Full Screen`}
      >
        <div className="flex h-12 items-center gap-3.5 border-b border-(--border) bg-(--viewer-panel) px-6 site:h-auto site:min-h-12 site:flex-wrap site:gap-3 site:py-3 site:break-all">
          <span className="text-[11px] tracking-[0.16em] text-(--muted-fg) uppercase site:font-mono site:text-sm site:font-medium site:tracking-[0.14em] site:text-mint">
            {kind}
          </span>
          <b className="font-mono text-[13px]">{file.path}</b>
          <span className="text-xs text-(--muted-fg) site:font-mono site:text-sm">{stats}</span>
          <span className="flex-1" />
          <span className="text-xs text-(--faint) site:hidden site:font-mono site:text-sm site:text-dim site:sm:inline">
            esc to close
          </span>
          <button type="button" className={viewerButton} onClick={() => setFullscreen(false)}>
            Exit Full Screen
          </button>
        </div>
        <div className="overflow-auto px-6 pt-4 pb-10 [&_pre]:p-0 site:pb-4">{body}</div>
      </div>
    );
  }
  return (
    <div className={sheetBody} ref={scrollToEndWhenTail(Boolean(file.tail))}>
      {file.tail && (
        <p className={`${notice} site:p-0!`}>
          Showing the end of the log, where sandbox failures are reported.{" "}
          <button type="button" className={viewerLink} onClick={file.tail.loadFull}>
            Load Full File
          </button>
        </p>
      )}
      <Block
        title={kind}
        detail={file.path}
        right={
          <span className="inline-flex items-baseline gap-3.5 site:items-center site:gap-3">
            <span>{stats}</span>
            <button type="button" className={viewerLink} onClick={() => setFullscreen(true)}>
              Full Screen
            </button>
          </span>
        }
      >
        {body}
      </Block>
    </div>
  );
}

function scrollToEndWhenTail(tail: boolean): (node: HTMLDivElement | null) => void {
  return (node) => {
    if (node && tail) node.scrollTop = node.scrollHeight;
  };
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
