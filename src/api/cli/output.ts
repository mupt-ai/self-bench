import type { Values } from "./args.js";

/** A column: its heading and how a row shows in it. */
export type Column<Row> = [heading: string, cell: (row: Row) => unknown];

/** JSON when asked for, or when the output is piped; otherwise the human view. */
function wantsJson(values: Values): boolean {
  return values.json === true || !process.stdout.isTTY;
}

/** Prints the reply as JSON, or as `human` renders it on a terminal. */
export function print(values: Values, reply: unknown, human?: () => string): void {
  console.log(wantsJson(values) || !human ? JSON.stringify(reply, null, 2) : human());
}

/** Rows as an aligned plain-text table. */
export function table<Row>(rows: readonly Row[], columns: readonly Column<Row>[]): string {
  if (rows.length === 0) return "(none)";
  const cells = rows.map((row) => columns.map(([, cell]) => text(cell(row))));
  const widths = columns.map(([heading], index) =>
    Math.max(heading.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const line = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(columns.map(([heading]) => heading)), ...cells.map(line)].join("\n");
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  return shown.replace(/\s+/g, " ").slice(0, 80);
}

export const percent = (value: number | undefined) =>
  value === undefined ? "" : `${value.toFixed(1)}%`;
export const usd = (value: number | undefined) =>
  value === undefined ? "" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
