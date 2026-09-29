import { useState } from "react";

/**
 * Sorting for tables on both sites, selfbench.dev and the app: a column's key and a direction.
 * `SortButton` (review/src/components/SortButton.tsx) is the header control that goes with it.
 */
export type SortDirection = "asc" | "desc";

export interface TableSort<Key extends string> {
  key: Key;
  direction: SortDirection;
}

/**
 * The sort after pressing a column's header: the other way round if the table is already sorted
 * by that column, otherwise the column's own first direction (highest first for a score, say).
 */
export function nextSort<Key extends string>(
  current: TableSort<Key>,
  key: Key,
  first: SortDirection,
): TableSort<Key> {
  if (current.key !== key) return { key, direction: first };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** `rows` ordered by `value` in `direction`; rows that tie keep the order they came in. */
export function sortRows<Row>(
  rows: readonly Row[],
  value: (row: Row) => number | string,
  direction: SortDirection,
): Row[] {
  const sign = direction === "asc" ? 1 : -1;
  return rows
    .map((row) => ({ row, value: value(row) }))
    .sort((left, right) => (left.value < right.value ? -sign : left.value > right.value ? sign : 0))
    .map(({ row }) => row);
}

/** A table's sort, starting at `initial`; `toggle` is what a header press does. */
export function useTableSort<Key extends string>(
  initial: TableSort<Key>,
  first: Record<Key, SortDirection>,
) {
  const [sort, setSort] = useState(initial);
  return { sort, toggle: (key: Key) => setSort((current) => nextSort(current, key, first[key])) };
}
