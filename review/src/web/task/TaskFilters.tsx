import { type ReactNode, useId } from "react";
import type { TaskState } from "../api";
import { SearchInput, Select } from "../ui";
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
  actions,
}: {
  counts: Record<Filter, number> | null;
  filter: Filter;
  onFilter(filter: Filter): void;
  query: string;
  onQuery(query: string): void;
  disabled: boolean;
  actions?: ReactNode;
}) {
  const statusId = useId();
  return (
    <div className="border-b border-border">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          className="w-full sm:max-w-80"
          placeholder="Search Tasks…"
          value={query}
          disabled={disabled}
          onChange={(event) => onQuery(event.target.value)}
          aria-label="Search Tasks"
          title="Search by task, PR, or run"
        />
        <label
          htmlFor={statusId}
          className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground [&>span]:flex-1 sm:[&>span]:w-48"
        >
          Status
          <Select
            id={statusId}
            value={filter}
            disabled={disabled}
            onChange={(event) => onFilter(event.target.value as Filter)}
          >
            {FILTERS.map((key) => (
              <option key={key} value={key}>
                {key === "all" ? "All Tasks" : STATE_LABEL[key]}
                {counts ? ` (${counts[key]})` : ""}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {actions}
    </div>
  );
}
