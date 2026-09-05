import React from "react";
import {
  addPullRequest,
  fetchMergedPullRequests,
  formatAgo,
  type MergedPullRequest,
  type TaskItem,
} from "./api";
import type { SiteOrg } from "./session";

export interface AddPrSheetProps {
  org: SiteOrg;
  fullName: string;
  onClose: () => void;
  onStarted: (task: TaskItem) => void;
}

/** One merged PR becomes one task: the pipeline authors and verifies it in its own workflow. */
export function AddPrSheet({ org, fullName, onClose, onStarted }: AddPrSheetProps) {
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<number | null>(null);
  const [rows, setRows] = React.useState<MergedPullRequest[]>([]);
  const [page, setPage] = React.useState(1);
  const [nextPage, setNextPage] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [incomplete, setIncomplete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reloads the same page.
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setListError(null);
    fetchMergedPullRequests(org.login, fullName, page).then(
      (result) => {
        if (!active) return;
        setRows((previous) =>
          page === 1
            ? result.pullRequests
            : [
                ...previous,
                ...result.pullRequests.filter(
                  (row) => !previous.some((item) => item.number === row.number),
                ),
              ],
        );
        setNextPage(result.nextPage);
        setIncomplete(result.incomplete);
        setLoading(false);
      },
      (cause: Error) => {
        if (!active) return;
        setListError(cause.message);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [org.login, fullName, page, retry]);

  React.useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const query = search.trim().toLowerCase();
  const visible = rows.filter((pr) =>
    `${pr.title} #${pr.number} ${pr.author}`.toLowerCase().includes(query),
  );

  const submit = () => {
    if (selected === null || busy) return;
    setBusy(true);
    setError(null);
    addPullRequest(org.login, fullName, String(selected)).then(
      (task) => {
        setBusy(false);
        onStarted(task);
      },
      (cause: Error) => {
        setBusy(false);
        setError(cause.message);
      },
    );
  };

  return (
    <div
      className="sheet-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="add-pr-title">
        <header className="sheet-head">
          <div>
            <div className="eyebrow">Add PR</div>
            <h2 id="add-pr-title">Build a Task From a Pull Request</h2>
            <p className="sheet-sub">
              A merged pull request in <span className="mono">{fullName}</span>. The pipeline
              authors a task from it, verifies it, and puts it up for review.
            </p>
          </div>
          <button ref={closeButton} type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <input
          className="sheet-search"
          type="search"
          placeholder="Search Listed PRs…"
          aria-label="Search Listed Pull Requests"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="repo-list" aria-busy={loading}>
          {visible.map((pr) => (
            <button
              key={pr.number}
              type="button"
              className={`repo-row${selected === pr.number ? " selected" : ""}`}
              aria-pressed={selected === pr.number}
              disabled={busy}
              onClick={() => {
                setSelected(pr.number);
                setError(null);
              }}
            >
              <span className="repo-detail">
                <span className="repo-detail-name">{pr.title}</span>
                <span className="repo-detail-line">
                  #{pr.number} · {pr.author} · merged {formatAgo(pr.mergedAt)}
                </span>
              </span>
            </button>
          ))}
          {loading && (
            <p className="repo-note" role="status">
              Loading merged pull requests…
            </p>
          )}
          {listError && (
            <p className="repo-note error" role="alert">
              {listError}{" "}
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          )}
          {!loading && !listError && visible.length === 0 && (
            <p className="repo-note">
              {query ? "No matching pull requests." : "No merged pull requests found on this page."}
            </p>
          )}
          {incomplete && (
            <p className="repo-note">
              GitHub returned partial results. Try reopening the picker to refresh.
            </p>
          )}
          {!loading && !listError && nextPage !== null && (
            <button
              type="button"
              className="btn-secondary pr-load-more"
              onClick={() => setPage(nextPage)}
            >
              Load More
            </button>
          )}
        </div>
        {error && (
          <p className="repo-note error" role="alert">
            {error}
          </p>
        )}
        <footer className="sheet-foot">
          <span className="repo-detail-name">
            {selected === null ? "Choose a Pull Request" : `PR #${selected}`}
          </span>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || selected === null}
            onClick={submit}
          >
            {busy ? "Starting…" : "Build Task"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
