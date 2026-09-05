import React from "react";
import { DiffView } from "../components/DiffView";
import { Block, Script } from "../components/Script";
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

  if (!file) return <p className="notice">Select a file to inspect.</p>;
  if (file.loading) return <p className="loading">reading {file.path}</p>;
  if (file.error) return <p className="notice bad">{file.error}</p>;
  const size = file.sizeBytes ?? file.text?.length ?? 0;
  if (file.text === undefined) {
    return (
      <div className="sheet-body">
        <Block title="binary file" detail={file.path}>
          <p className="muted">
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
      <div className="fullscreen" role="dialog" aria-label={`${file.path} full screen`}>
        <div className="fullscreen-head">
          <span className="fullscreen-kind">{kind}</span>
          <b className="mono">{file.path}</b>
          <span className="fullscreen-stats">{stats}</span>
          <span className="grow" />
          <span className="kbd">esc to close</span>
          <button type="button" className="btn" onClick={() => setFullscreen(false)}>
            Exit Full Screen
          </button>
        </div>
        <div className="fullscreen-body">{body}</div>
      </div>
    );
  }
  return (
    <div className="sheet-body" ref={scrollToEndWhenTail(Boolean(file.tail))}>
      {file.tail && (
        <p className="notice">
          Showing the end of the log, where sandbox failures are reported.{" "}
          <button type="button" className="link" onClick={file.tail.loadFull}>
            Load Full File
          </button>
        </p>
      )}
      <Block
        title={kind}
        detail={file.path}
        right={
          <span className="block-actions">
            <span>{stats}</span>
            <button type="button" className="link" onClick={() => setFullscreen(true)}>
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
