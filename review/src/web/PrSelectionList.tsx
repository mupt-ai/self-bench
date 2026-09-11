import type { MergedPullRequest } from "./api";
import { formatAgo } from "./api";
import { Button, SearchInput } from "./ui";

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
      <SearchInput
        className="mx-4 shrink-0 sm:mx-6"
        placeholder="Search Listed PRs…"
        aria-label="Search Listed Pull Requests"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div
        className="mt-4 max-h-[55dvh] min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6"
        aria-busy={loading}
      >
        {visible.map((pr) => (
          <label
            key={pr.number}
            className={`flex w-full cursor-pointer items-start gap-3 border-b border-border px-3 py-3 text-left text-foreground hover:bg-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-2px] has-[:focus-visible]:outline-brand has-[:disabled]:cursor-default has-[:disabled]:opacity-55${selected.has(pr.number) ? " bg-brand/5" : ""}`}
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
              className={`flex size-4 shrink-0 items-center justify-center self-center border ${selected.has(pr.number) ? "border-brand bg-brand text-background" : "border-input"}`}
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
              <span className="block font-mono text-sm leading-6 text-foreground/80 wrap-anywhere">
                {pr.title}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-muted-foreground">
                <span className="text-brand/80">#{pr.number}</span>
                <span className="min-w-0 break-all">{pr.author}</span>
                {started.has(pr.number) && <span className="text-brand">Started</span>}
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
                <div key={row} className="flex gap-3 border-b border-border px-2 py-3">
                  <div className="size-4 shrink-0 self-center border border-border" />
                  <div className="min-w-0 flex-1 py-1">
                    <div className={`h-3 bg-accent ${row % 2 ? "w-4/5" : "w-3/5"}`} />
                    <div className="mt-3 flex items-center gap-2">
                      <div className="h-2.5 w-8 bg-accent" />
                      <div className="h-2.5 w-16 bg-accent" />
                      <div className="ml-auto h-2.5 w-12 bg-accent" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {listError && (
          <p
            className="py-4 text-muted-foreground mt-4 font-mono text-sm leading-relaxed text-destructive"
            role="alert"
          >
            {listError}{" "}
            <Button type="button" variant="ghost" onClick={() => onRetry()}>
              Retry
            </Button>
          </p>
        )}
        {!loading && !listError && visible.length === 0 && (
          <p className="py-4 font-mono text-sm leading-5 text-muted-foreground">
            {query ? "No matching pull requests." : "No merged pull requests found on this page."}
          </p>
        )}
        {incomplete && (
          <p className="py-4 font-mono text-sm leading-5 text-muted-foreground">
            GitHub returned partial results. Try reopening the picker to refresh.
          </p>
        )}
        {!loading && !listError && nextPage !== null && (
          <Button
            type="button"
            className="mx-auto mt-4 flex w-fit"
            disabled={busy}
            onClick={() => onMore()}
          >
            Load More
          </Button>
        )}
      </div>
    </>
  );
}
