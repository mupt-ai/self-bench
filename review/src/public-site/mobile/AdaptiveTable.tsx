import { Fragment, type ReactNode } from "react";
import { PANEL } from "../frame";

/**
 * What a column is, which decides where it goes when the table becomes cards:
 * - title: names the row, and heads its card;
 * - detail: describes it; a card's details share one line under its title;
 * - metric: measures it; a card's metrics sit side by side at its foot, each under its header.
 */
type ColumnRole = "title" | "detail" | "metric";

export interface Column<Row> {
  header: string;
  role: ColumnRole;
  cell: (row: Row) => ReactNode;
  /** Extra classes for this column's header and cells when shown as a table. */
  className?: string;
}

/**
 * Rows as a table where there is room, and as a stack of cards where there is not. Both come
 * from the one column list, and the switch follows the table's own width (a container query)
 * rather than the window's, so it holds wherever the table is placed. A column added for the
 * table shows on the cards too, placed by its role, so the two never need separate upkeep.
 *
 * The table needs 45rem; below that, the cards (both are in the page, one of them hidden).
 */
export function AdaptiveTable<Row>({
  columns,
  rows,
  rowKey,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
}) {
  const role = (wanted: ColumnRole) => columns.filter((column) => column.role === wanted);
  const details = role("detail");
  const metrics = role("metric");
  return (
    <div className="@container">
      <div className={`hidden overflow-x-auto @min-[45rem]:block ${PANEL}`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
              {columns.map((column) => (
                <th
                  key={column.header}
                  className={`px-3 py-2 font-medium ${column.className ?? ""}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className="border-b border-border last:border-b-0 hover:bg-muted/60"
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
      <ul className={`divide-y divide-border @min-[45rem]:hidden ${PANEL}`}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="flex flex-col gap-2 px-3 py-3 text-sm">
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
  );
}
