import { Maximize2, Minimize2 } from "lucide-react";
import React from "react";
import { formatBytes } from "../lib/format";
import { fileKind } from "../lib/task-model";
import { DiffView } from "./DiffView";
import { Block, Script } from "./Script";
import { notice, sheetBody, viewerIconButton } from "./viewer-ui";

export interface OpenFile {
  path: string;
  sizeBytes?: number;
  text?: string;
  error?: string;
}

/** Prose, which wraps; code and config keep their lines and scroll sideways. */
const PROSE = /\.(md|markdown|txt)$/i;

const KIND_LABELS: Record<string, string> = {
  patch: "Patch",
  json: "JSON",
  toml: "TOML",
  dockerfile: "Dockerfile",
  shell: "Shell",
  text: "Text",
};

/**
 * One file of a task: a patch as a diff, JSON laid out, other text with numbered lines, each
 * openable full screen. Shared by the app's task page and selfbench.dev's task viewer.
 */
export function FileViewer({
  file,
  binary,
}: {
  file: OpenFile | null;
  /** What a file without text shows in its place. */
  binary?: React.ReactNode;
}) {
  const [fullscreen, setFullscreen] = React.useState(false);
  const expand = React.useRef<HTMLButtonElement>(null);
  const leaving = React.useRef(false);
  // Leaving full screen puts focus back on the button that opened it, which was out of the page
  // while the file was full screen, so the dialog could not remember it.
  React.useEffect(() => {
    if (fullscreen || !leaving.current) return;
    leaving.current = false;
    expand.current?.focus();
  }, [fullscreen]);

  if (!file) return <p className={notice}>Select a file to inspect.</p>;
  if (file.error) return <p className={`${notice} !text-destructive`}>{file.error}</p>;
  const size = file.sizeBytes ?? file.text?.length ?? 0;
  let content: React.ReactNode;
  if (file.text === undefined) {
    content = (
      <Block title="Not Shown" detail={file.path}>
        {binary ?? (
          <p className="px-4 py-3 text-muted-foreground">
            {formatBytes(size)} · not shown inline. Repository snapshots and archives stay on the
            server.
          </p>
        )}
      </Block>
    );
  } else {
    const kind = fileKind(file.path);
    const kindLabel = KIND_LABELS[kind] ?? kind;
    const lines = file.text.replace(/\n$/, "").split("\n").length;
    const stats = `${formatBytes(size)} · ${lines} ${lines === 1 ? "line" : "lines"}`;
    const body =
      kind === "patch" ? (
        <DiffView patch={file.text} />
      ) : kind === "json" ? (
        <Script text={prettyJson(file.text)} />
      ) : (
        <Script text={file.text} wrap={PROSE.test(file.path)} />
      );
    content = fullscreen ? (
      <FullScreen
        path={file.path}
        kindLabel={kindLabel}
        stats={stats}
        onExit={() => {
          leaving.current = true;
          setFullscreen(false);
        }}
      >
        {body}
      </FullScreen>
    ) : (
      <Block
        title={kindLabel}
        detail={file.path}
        right={
          <span className="inline-flex items-center gap-3">
            <span>{stats}</span>
            <button
              ref={expand}
              type="button"
              className="hit relative inline-flex size-8 cursor-pointer items-center justify-center text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
              onClick={() => setFullscreen(true)}
              aria-label="Full Screen"
              title="Full Screen"
            >
              <Maximize2 aria-hidden="true" className="size-4" />
            </button>
          </span>
        }
      >
        {body}
      </Block>
    );
  }
  return <div className={sheetBody}>{content}</div>;
}

/**
 * The file over the whole screen, as a modal dialog: Escape closes only it, even inside another
 * dialog, since the browser cancels the topmost one.
 */
function FullScreen({
  path,
  kindLabel,
  stats,
  onExit,
  children,
}: {
  path: string;
  kindLabel: string;
  stats: string;
  onExit(): void;
  children: React.ReactNode;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  // Opened before the first paint, so it never shows in the page's flow.
  React.useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={`${path} Full Screen`}
      onCancel={(event) => {
        // React carries the cancel up to a dialog around this one; it is for this one only.
        event.preventDefault();
        event.stopPropagation();
        onExit();
      }}
      className="m-0 hidden h-dvh max-h-none w-full max-w-none grid-rows-[auto_minmax(0,1fr)] border-0 bg-background p-0 text-foreground open:grid"
    >
      <div className="flex min-h-12 flex-wrap items-center gap-3 border-b border-border bg-(--viewer-panel) px-6 py-3 break-all">
        <span className="text-xs font-semibold text-muted-foreground">{kindLabel}</span>
        <b className="font-mono text-sm">{path}</b>
        <span className="font-mono text-sm text-muted-foreground">{stats}</span>
        <span className="flex-1" />
        <span className="hidden font-mono text-sm text-muted-foreground sm:inline">
          esc to close
        </span>
        <button
          type="button"
          className={`${viewerIconButton} hit relative`}
          onClick={onExit}
          aria-label="Exit Full Screen"
          title="Exit Full Screen"
        >
          <Minimize2 aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="overflow-auto px-6 py-4 [&_pre]:p-0">{children}</div>
    </dialog>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
