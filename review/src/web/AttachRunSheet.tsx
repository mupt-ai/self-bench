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
      className="sheet-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="attach-title">
        <header className="sheet-head">
          <div>
            <div className="eyebrow">Attach Run</div>
            <h2 id="attach-title">Choose a Pipeline Run</h2>
            <p className="sheet-sub">
              Runs in the artifact store. Their candidates become tasks of{" "}
              <span className="mono">{fullName}</span>.
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <input
          className="sheet-search"
          type="search"
          placeholder="Search runs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search runs"
        />
        <div className="repo-list" role="listbox" aria-label="Runs">
          {!runs && !error && <p className="repo-note">Listing runs…</p>}
          {error && <p className="repo-note error">{error}</p>}
          {runs && visible.length === 0 && <p className="repo-note">No runs match.</p>}
          {visible.map((run) => {
            const done = attached.has(run.runId);
            return (
              <button
                type="button"
                key={run.runId}
                role="option"
                aria-selected={done}
                disabled={done || busy !== null}
                className="repo-row"
                onClick={() => attach(run)}
              >
                <span className="repo-name">{run.runId}</span>
                <span className="repo-meta">
                  {done && <span className="repo-badge connected">attached</span>}
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
