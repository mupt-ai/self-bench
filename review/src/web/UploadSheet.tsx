import React from "react";
import { MAX_UPLOAD_BYTES, type UploadPreview, uploadArchive } from "./upload-api";

export function UploadSheet({
  org,
  fullName,
  onClose,
  onImported,
}: {
  org: string;
  fullName: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<UploadPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"validate" | "import" | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      controller.current?.abort();
      previous?.focus();
    };
  }, []);
  const submit = async (receipt?: string) => {
    if (!file) return;
    setBusy(receipt ? "import" : "validate");
    setError(null);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await uploadArchive(org, fullName, file, receipt, abort.signal);
      if (abort.signal.aborted) return;
      if ("receipt" in result) setPreview(result);
      else onImported();
    } catch (cause) {
      if (!abort.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (receipt) setPreview(null);
      }
    } finally {
      if (!abort.signal.aborted) setBusy(null);
    }
  };
  const eligible =
    preview?.tasks.filter((task) => !task.errors.length && !task.conflicts.length).length ?? 0;
  return (
    <div
      className="sheet-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <aside
        className="sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
          if (event.key === "Tab") {
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), summary",
              ),
            ];
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="sheet-head">
          <div>
            <div className="eyebrow">Upload</div>
            <h2 id="upload-title">Import Harbor tasks</h2>
            <p className="sheet-sub">
              One or more Harbor tasks, or a SelfBench export. TAR, TAR.GZ or TGZ; up to 32 MiB
              compressed, 128 MiB expanded, 200 tasks.
            </p>
          </div>
          <button type="button" className="btn-ghost" disabled={busy !== null} onClick={onClose}>
            Close
          </button>
        </header>
        <p className="repo-note">
          Uploaded / unverified. We inspect files only—never run environments, tests or solutions.
          Human review is separate.
        </p>
        <input
          ref={input}
          type="file"
          accept=".tar,.tar.gz,.tgz"
          aria-label="Task archive"
          disabled={busy !== null}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            setPreview(null);
            setError(null);
            setFile(null);
            if (selected && (selected.size > MAX_UPLOAD_BYTES || selected.size === 0))
              setError("Choose a non-empty archive up to 32 MiB.");
            else setFile(selected);
          }}
        />
        {error && (
          <p className="repo-note error" role="alert">
            {error}
          </p>
        )}
        {!preview && (
          <button
            type="button"
            className="btn-primary"
            disabled={!file || busy !== null}
            onClick={() => void submit()}
          >
            {busy ? "Validating…" : "Validate archive"}
          </button>
        )}
        {preview && (
          <>
            <p className="repo-note" role="status">
              {eligible} ready to import · {preview.tasks.length - eligible} skipped (malformed or
              duplicate)
            </p>
            <ul className="repo-list">
              {preview.tasks.map(
                (
                  task,
                  index, // biome-ignore lint/suspicious/noArrayIndexKey: immutable preview includes duplicate IDs intentionally
                ) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: immutable preview includes duplicate IDs intentionally
                  <li className="repo-row" key={`${index}:${task.taskId}`}>
                    <span className="repo-name">{task.taskId}</span>
                    <span className="repo-meta">
                      {[...task.errors, ...task.conflicts].join(" · ") ||
                        "Ready · Uploaded / unverified"}
                    </span>
                  </li>
                ),
              )}
            </ul>
            {preview.manifest && (
              <details>
                <summary>Preserved export metadata (untrusted)</summary>
                <pre>{JSON.stringify(preview.manifest, null, 2)}</pre>
              </details>
            )}
            <button
              type="button"
              className="btn-primary"
              disabled={!eligible || busy !== null}
              onClick={() => void submit(preview.receipt)}
            >
              {busy === "import"
                ? "Importing…"
                : `Import ${eligible} valid task${eligible === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
