import { Fragment, type ReactNode } from "react";
import { ariaSort, SortButton } from "../../components/SortButton";
import type { SortDirection, TableSort } from "../../lib/table-sort";
import { PANEL } from "../frame";

/**
 * What a column is, which decides where it goes when the table becomes cards:
 * - title: names the row, and heads its card;
 * - detail: describes it; a card's details share one line under its title;
 * - metric: measures it; a card's metrics sit side by side at its foot, each under its header.
 */
type ColumnRole = "title" | "detail" | "metric";

export interface Column<Row, Key extends string = string> {
  header: string;
  role: ColumnRole;
  cell: (row: Row) => ReactNode;
  /** Extra classes for this column's header and cells when shown as a table. */
  className?: string;
  /** Makes the column sortable: its key in the table's `sort`, and the way it sorts first. */
  sort?: { key: Key; first: SortDirection };
}

/**
 * Rows as a table where there is room, and as a stack of cards where there is not. Both come
 * from the one column list, and the switch follows the table's own width (a container query)
 * rather than the window's, so it holds wherever the table is placed. A column added for the
 * table shows on the cards too, placed by its role, so the two never need separate upkeep.
 *
 * The table needs 45rem; below that, the cards (both are in the page, one of them hidden).
 */
export function AdaptiveTable<Row, Key extends string = string>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  rowClassName,
}: {
  columns: Column<Row, Key>[];
  /** In the order to show them; a sortable table's owner sorts them (see `useTableSort`). */
  rows: Row[];
  rowKey: (row: Row) => string;
  /** The current sort, when some columns are sortable, and what pressing a header does. */
  sort?: TableSort<Key>;
  onSort?: (key: Key) => void;
  /** Extra classes for a row, as a table row and as a card: a highlight, say. */
  rowClassName?: (row: Row) => string;
}) {
  const role = (wanted: ColumnRole) => columns.filter((column) => column.role === wanted);
  const details = role("detail");
  const metrics = role("metric");
  const sortButton = (column: Column<Row, Key>) =>
    column.sort && sort && onSort ? (
      <SortButton
        label={column.header}
        sortKey={column.sort.key}
        sort={sort}
        first={column.sort.first}
        onSort={onSort}
      />
    ) : null;
  const sortable = columns.filter((column) => column.sort);
  return (
    <div className="@container">
      <div className={`hidden overflow-x-auto @min-[45rem]:block ${PANEL}`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
              {columns.map((column) => (
                <th
                  key={column.header}
                  aria-sort={column.sort && sort ? ariaSort(sort, column.sort.key) : undefined}
                  className={`px-3 py-2 font-medium ${column.className ?? ""}`}
                >
                  {sortButton(column) ?? column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={`border-b border-border transition-[opacity,background-color] last:border-b-0 hover:bg-muted/60 ${rowClassName?.(row) ?? ""}`}
              >
                {columns.map((column) => (
                  <td
                    key={column.header}
                    className={`px-3 py-2 ${column.role === "detail" ? "text-muted-foreground" : ""} ${column.className ?? ""}`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={`@min-[45rem]:hidden ${PANEL}`}>
        {/* Cards have no header row, so their sort controls sit above them. */}
        {sortable.length > 0 && sort && onSort && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span>Sort By</span>
            {sortable.map((column) => (
              <span key={column.header}>{sortButton(column)}</span>
            ))}
          </div>
        )}
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li
              key={rowKey(row)}
              className={`flex flex-col gap-2 px-3 py-3 text-sm transition-[opacity,background-color] ${rowClassName?.(row) ?? ""}`}
            >
              {role("title").map((column) => (
                <div key={column.header}>{column.cell(row)}</div>
              ))}
              {details.length > 0 && (
                <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                  {details.map((column, index) => (
                    <Fragment key={column.header}>
                      {index > 0 && <span aria-hidden="true">·</span>}
                      <span>
                        <span className="sr-only">{column.header}: </span>
                        {column.cell(row)}
                      </span>
                    </Fragment>
                  ))}
                </p>
              )}
              {metrics.length > 0 && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {metrics.map((column) => (
                    <div key={column.header} className="flex min-w-0 flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">{column.header}</dt>
                      <dd>{column.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
