import type { MergedPullRequest } from "./api";
import { formatAgo } from "./api";

export function PrSelectionList({
  search,
  setSearch,
  visible,
  selected,
  started,
  busy,
  loading,
  listError,
  query,
  incomplete,
  nextPage,
  onToggle,
  onRetry,
  onMore,
}: {
  search: string;
  setSearch: (value: string) => void;
  visible: MergedPullRequest[];
  selected: Set<number>;
  started: Set<number>;
  busy: boolean;
  loading: boolean;
  listError: string | null;
  query: string;
  incomplete: boolean;
  nextPage: number | null;
  onToggle: (number: number) => void;
  onRetry: () => void;
  onMore: () => void;
}) {
  return (
    <>
      <input
        className="mx-5 h-11 shrink-0 min-w-0 border border-line-strong bg-bg px-3 font-mono text-sm text-ink placeholder:text-dim focus:border-mint sm:mx-6"
        type="search"
        placeholder="Search Listed PRs…"
        aria-label="Search Listed Pull Requests"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div
        className="mt-4 max-h-[55vh] min-h-0 flex-1 overflow-y-auto px-3 pb-4 sm:px-4"
        aria-busy={loading}
      >
        {visible.map((pr) => (
          <label
            key={pr.number}
            className={`flex w-full cursor-pointer items-start gap-3 border-b border-line px-3 py-3 text-left text-ink hover:bg-surface-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-2px] has-[:focus-visible]:outline-mint has-[:disabled]:cursor-default has-[:disabled]:opacity-55${selected.has(pr.number) ? " bg-mint/5" : ""}`}
          >
            <input
              className="sr-only"
              type="checkbox"
              checked={selected.has(pr.number)}
              disabled={busy || started.has(pr.number)}
              onChange={() => onToggle(pr.number)}
            />
            <span
              aria-hidden="true"
              className={`flex size-4 shrink-0 items-center justify-center self-center border ${selected.has(pr.number) ? "border-mint bg-mint text-bg" : "border-line-strong"}`}
            >
              {selected.has(pr.number) && (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="size-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m3 8 3 3 7-7" />
                </svg>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-sm leading-6 text-ink/80 wrap-anywhere">
                {pr.title}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[13px] leading-5 text-muted">
                <span className="text-mint/80">#{pr.number}</span>
                <span className="min-w-0 break-all">{pr.author}</span>
                {started.has(pr.number) && <span className="text-mint">Started</span>}
                <span className="ml-auto whitespace-nowrap">{formatAgo(pr.mergedAt)}</span>
              </span>
            </span>
          </label>
        ))}
        {loading && (
          <div role="status" aria-label="Loading Merged Pull Requests">
            <span className="sr-only">Loading merged pull requests…</span>
            <div aria-hidden="true" className="motion-safe:animate-pulse">
              {(visible.length ? [1, 2] : [1, 2, 3, 4, 5, 6]).map((row) => (
                <div key={row} className="flex gap-3 border-b border-line px-2 py-3">
                  <div className="size-4 shrink-0 self-center border border-line" />
                  <div className="min-w-0 flex-1 py-1">
                    <div className={`h-3 bg-surface-3 ${row % 2 ? "w-4/5" : "w-3/5"}`} />
                    <div className="mt-3 flex items-center gap-2">
                      <div className="h-2.5 w-8 bg-surface-3" />
                      <div className="h-2.5 w-16 bg-surface-3" />
                      <div className="ml-auto h-2.5 w-12 bg-surface-3" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {listError && (
          <p
            className="py-4 text-muted mt-4 font-mono text-sm leading-relaxed text-danger"
            role="alert"
          >
            {listError}{" "}
            <button
              type="button"
              className="inline-flex min-h-9 items-center justify-center gap-2 px-3 font-sans text-[13px] text-muted hover:text-mint-bright disabled:opacity-40"
              onClick={() => onRetry()}
            >
              Retry
            </button>
          </p>
        )}
        {!loading && !listError && visible.length === 0 && (
          <p className="py-4 font-mono text-[13px] leading-5 text-muted">
            {query ? "No matching pull requests." : "No merged pull requests found on this page."}
          </p>
        )}
        {incomplete && (
          <p className="py-4 font-mono text-[13px] leading-5 text-muted">
            GitHub returned partial results. Try reopening the picker to refresh.
          </p>
        )}
        {!loading && !listError && nextPage !== null && (
          <button
            type="button"
            className="mx-auto mt-5 mb-1 flex h-9 w-fit shrink-0 items-center justify-center border border-line-strong bg-transparent px-4 font-sans text-[13px] font-bold text-ink hover:border-mint hover:text-mint-bright"
            disabled={busy}
            onClick={() => onMore()}
          >
            Load More
          </button>
        )}
      </div>
    </>
  );
}
