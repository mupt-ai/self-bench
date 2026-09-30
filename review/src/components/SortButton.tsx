import { ChevronsUpDown } from "lucide-react";
import type { SortDirection, TableSort } from "../lib/table-sort";

/**
 * A column header's sort control, shared by selfbench.dev and the app and ported from the Dari
 * dashboard: the label and a pair of chevrons. An unsorted column shows both chevrons faintly;
 * the sorted one lights the chevron for its direction in the brand color. Put it inside the
 * header cell and give the cell `aria-sort={ariaSort(sort, key)}`.
 */
export function SortButton<Key extends string>({
  label,
  sortKey,
  sort,
  first,
  onSort,
}: {
  label: string;
  sortKey: Key;
  sort: TableSort<Key>;
  /** The direction the column sorts in when first pressed. */
  first: SortDirection;
  onSort: (key: Key) => void;
}) {
  const active = sort.key === sortKey;
  const next = active ? (sort.direction === "asc" ? "desc" : "asc") : first;
  // The icon's first path is the lower (down) chevron, its last the upper (up) one.
  const lit = !active
    ? "opacity-50"
    : sort.direction === "asc"
      ? "[&>path:first-child]:stroke-muted-foreground/30 [&>path:last-child]:stroke-brand"
      : "[&>path:first-child]:stroke-brand [&>path:last-child]:stroke-muted-foreground/30";
  return (
    <button
      type="button"
      aria-label={`Sort by ${label}, ${next === "asc" ? "ascending" : "descending"}`}
      onClick={() => onSort(sortKey)}
      className={`hit relative inline-flex cursor-pointer items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
    >
      {label}
      <ChevronsUpDown className={`size-3.5 shrink-0 ${lit}`} aria-hidden="true" />
    </button>
  );
}

/** The `aria-sort` of a sortable column's header cell. */
export function ariaSort<Key extends string>(sort: TableSort<Key>, key: Key) {
  if (sort.key !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}
