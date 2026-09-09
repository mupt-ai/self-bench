import type { TaskState } from "../api";
import { STATE_LABEL } from "./state";
export type Filter = "all" | TaskState;
const FILTERS: Filter[] = ["all", "in_progress", "needs_review", "accepted", "rejected", "failed"];
export function TaskFilters({
  counts,
  filter,
  onFilter,
  query,
  onQuery,
  disabled,
}: {
  counts: Record<Filter, number>;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  query: string;
  onQuery: (query: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div
        className="flex max-w-full gap-1.5 overflow-x-auto"
        role="tablist"
        aria-label="Task State"
      >
        {FILTERS.map((key) => (
          <button
            type="button"
            key={key}
            role="tab"
            aria-selected={filter === key}
            className="inline-flex h-8 shrink-0 items-center gap-2 border border-line px-3 font-mono text-sm font-medium text-muted hover:border-line-strong hover:text-ink aria-selected:border-mint aria-selected:bg-surface-2 aria-selected:text-mint [&_b]:font-medium [&_b]:text-dim [&[aria-selected=true]_b]:text-mint-bright"
            disabled={disabled}
            onClick={() => onFilter(key)}
          >
            {key === "all" ? "All" : STATE_LABEL[key]}
            <b>{counts[key]}</b>
          </button>
        ))}
      </div>
      <div className="relative w-full sm:w-[220px]">
        <svg
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          className="h-9 w-full min-w-0 border border-line bg-transparent pr-3 pl-9 font-mono text-[13px] text-ink placeholder:text-muted hover:border-line-strong focus:border-mint disabled:opacity-50"
          type="search"
          placeholder="Search Tasks…"
          value={query}
          disabled={disabled}
          onChange={(event) => onQuery(event.target.value)}
          aria-label="Search Tasks"
          title="Search by task, PR, or run"
        />
      </div>
    </div>
  );
}
