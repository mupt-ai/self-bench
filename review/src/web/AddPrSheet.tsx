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
      className="fixed inset-0 z-20 flex justify-end bg-bg/70"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="flex h-full w-full max-w-[520px] flex-col border-l border-line-strong bg-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-pr-title"
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 [&_h2]:mt-1.5 [&_h2]:font-sans [&_h2]:text-lg [&_h2]:leading-tight [&_h2]:font-semibold">
          <div>
            <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-mint uppercase">
              Add PR
            </div>
            <h2 id="add-pr-title">Build a Task From a Pull Request</h2>
            <p className="mt-1.5 text-muted">
              A merged pull request in <span className="font-mono">{fullName}</span>. The pipeline
              authors a task from it, verifies it, and puts it up for review.
            </p>
          </div>
          <button
            ref={closeButton}
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
          placeholder="Search Listed PRs…"
          aria-label="Search Listed Pull Requests"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4" aria-busy={loading}>
          {visible.map((pr) => (
            <button
              key={pr.number}
              type="button"
              className={`flex w-full items-baseline justify-between gap-4 border border-transparent border-b-line px-3 py-2.5 text-left text-ink hover:bg-surface-2 disabled:cursor-default disabled:opacity-55${selected === pr.number ? " border-mint bg-surface-2" : ""}`}
              aria-pressed={selected === pr.number}
              disabled={busy}
              onClick={() => {
                setSelected(pr.number);
                setError(null);
              }}
            >
              <span className="min-w-0">
                <span className="text-[13px] text-ink">{pr.title}</span>
                <span className="mt-1 flex gap-2 text-xs text-muted">
                  #{pr.number} · {pr.author} · merged {formatAgo(pr.mergedAt)}
                </span>
              </span>
            </button>
          ))}
          {loading && (
            <p className="py-4 text-muted" role="status">
              Loading merged pull requests…
            </p>
          )}
          {listError && (
            <p
              className="py-4 text-muted mt-4 font-mono text-xs leading-relaxed text-danger"
              role="alert"
            >
              {listError}{" "}
              <button
                type="button"
                className="inline-flex min-h-9 items-center justify-center gap-2 px-3 font-sans text-[13px] text-muted hover:text-mint-bright disabled:opacity-40"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          )}
          {!loading && !listError && visible.length === 0 && (
            <p className="py-4 text-muted">
              {query ? "No matching pull requests." : "No merged pull requests found on this page."}
            </p>
          )}
          {incomplete && (
            <p className="py-4 text-muted">
              GitHub returned partial results. Try reopening the picker to refresh.
            </p>
          )}
          {!loading && !listError && nextPage !== null && (
            <button
              type="button"
              className="inline-flex h-9 shrink-0 items-center justify-center border border-line-strong bg-transparent px-4 font-sans text-[13px] font-bold text-ink hover:border-mint hover:text-mint-bright mx-auto mt-5 mb-1 flex"
              onClick={() => setPage(nextPage)}
            >
              Load More
            </button>
          )}
        </div>
        {error && (
          <p
            className="py-4 text-muted mt-4 font-mono text-xs leading-relaxed text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line bg-surface-2 px-6 py-4">
          <span className="text-[13px] text-ink">
            {selected === null ? "Choose a Pull Request" : `PR #${selected}`}
          </span>
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-mint bg-mint px-4 font-sans text-[13px] font-bold text-bg hover:bg-mint-bright disabled:cursor-not-allowed disabled:opacity-40"
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
