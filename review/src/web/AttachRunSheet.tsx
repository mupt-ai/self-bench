import React from "react";
import { type ArchivedRun, type AttachedRun, attachRun, fetchArchivedRuns, formatAgo } from "./api";
import type { SiteOrg } from "./session";

export interface AttachRunSheetProps {
  org: SiteOrg;
  fullName: string;
  attached: ReadonlySet<string>;
  onClose: () => void;
  onAttached: (run: AttachedRun) => void;
}

/** Pick a pipeline run from the artifact store whose candidates should count as this repo's tasks. */
export function AttachRunSheet({
  org,
  fullName,
  attached,
  onClose,
  onAttached,
}: AttachRunSheetProps) {
  const [runs, setRuns] = React.useState<ArchivedRun[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchArchivedRuns().then(
      (found) => !cancelled && setRuns(found),
      (cause: Error) => !cancelled && setError(cause.message),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const attach = (run: ArchivedRun) => {
    setBusy(run.runId);
    attachRun(org.login, fullName, run.runId).then(
      (result) => {
        setBusy(null);
        onAttached(result);
      },
      (cause: Error) => {
        setBusy(null);
        setError(cause.message);
      },
    );
  };

  const needle = query.trim().toLowerCase();
  const visible = (runs ?? []).filter((run) => !needle || run.runId.includes(needle));

  return (
    <div
      className="fixed inset-0 z-20 flex justify-end bg-bg/70"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="flex h-full w-full max-w-[520px] flex-col border-l border-line-strong bg-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attach-title"
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 [&_h2]:mt-1.5 [&_h2]:font-sans [&_h2]:text-lg [&_h2]:leading-tight [&_h2]:font-semibold">
          <div>
            <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-mint uppercase">
              Attach Run
            </div>
            <h2 id="attach-title">Choose a Pipeline Run</h2>
            <p className="mt-1.5 text-muted">
              Runs in the artifact store. Their candidates become tasks of{" "}
              <span className="font-mono">{fullName}</span>.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex min-h-9 items-center justify-center gap-2 px-3 font-sans text-[13px] text-muted hover:text-mint-bright disabled:opacity-40"
            onClick={onClose}
          >
            Close
          </button>
        </header>
        <input
          className="mx-6 mb-2 h-10 min-w-0 border border-line-strong bg-bg px-3 font-mono text-[13px] text-ink placeholder:text-dim focus:border-mint"
          type="search"
          placeholder="Search runs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search runs"
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4" role="listbox" aria-label="Runs">
          {!runs && !error && <p className="py-4 text-muted">Listing runs…</p>}
          {error && (
            <p className="py-4 text-muted mt-4 font-mono text-xs leading-relaxed text-danger">
              {error}
            </p>
          )}
          {runs && visible.length === 0 && <p className="py-4 text-muted">No runs match.</p>}
          {visible.map((run) => {
            const done = attached.has(run.runId);
            return (
              <button
                type="button"
                key={run.runId}
                role="option"
                aria-selected={done}
                disabled={done || busy !== null}
                className="flex w-full items-baseline justify-between gap-4 border border-transparent border-b-line px-3 py-2.5 text-left text-ink hover:bg-surface-2 disabled:cursor-default disabled:opacity-55"
                onClick={() => attach(run)}
              >
                <span className="truncate font-mono text-[13px] font-medium">{run.runId}</span>
                <span className="flex shrink-0 gap-2.5 font-mono text-[11px] text-dim">
                  {done && (
                    <span className="text-[10px] tracking-widest text-warning uppercase text-mint">
                      attached
                    </span>
                  )}
                  {busy === run.runId && <span>attaching…</span>}
                  <span>{formatAgo(run.startedAt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
