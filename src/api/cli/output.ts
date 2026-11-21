import type { Values } from "./args.js";
import { out, status, visibleWidth } from "./style.js";

/** A column: its heading and how a row shows in it. */
export type Column<Row> = [heading: string, cell: (row: Row) => unknown];

/** JSON when asked for, or when the output is piped; otherwise the human view. */
function wantsJson(values: Values): boolean {
  return values.json === true || !process.stdout.isTTY;
}

/**
 * Prints the reply as JSON, or on a terminal as `human` renders it; a reply with no view of its
 * own is laid out as fields and tables.
 */
export function print(values: Values, reply: unknown, human?: () => string): void {
  const json = wantsJson(values);
  console.log(json ? JSON.stringify(reply, null, 2) : human ? human() : details(reply));
}

/** Columns whose cells are a status, drawn with a mark. */
const STATUS_COLUMNS = new Set(["STATUS", "STATE"]);

/** Rows as an aligned table, with dim headings and marked statuses on a terminal. */
export function table<Row>(rows: readonly Row[], columns: readonly Column<Row>[]): string {
  if (rows.length === 0) return out.dim("(none)");
  const cells = rows.map((row) =>
    columns.map(([heading, cell]) => {
      const value = text(cell(row));
      return STATUS_COLUMNS.has(heading) && value ? status(value) : value;
    }),
  );
  const widths = columns.map(([heading], index) =>
    Math.max(heading.length, ...cells.map((row) => visibleWidth(row[index] ?? ""))),
  );
  const pad = (value: string, index: number) =>
    value + " ".repeat(Math.max((widths[index] ?? 0) - visibleWidth(value), 0));
  const line = (values: string[]) => values.map(pad).join("  ").trimEnd();
  return [out.heading(line(columns.map(([heading]) => heading))), ...cells.map(line)].join("\n");
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  return shown.replace(/\s+/g, " ").slice(0, 80);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `createdAt` as `Created At`. */
const label = (key: string) =>
  key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

/** A scalar for a field: statuses marked, empty values dim. */
function scalar(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return out.dim("—");
  if (typeof value === "boolean") return value ? "yes" : out.dim("no");
  if (/^(status|state)$/i.test(key) && typeof value === "string") return status(value);
  return String(value).replace(/\s+/g, " ");
}

/**
 * Any API reply laid out for reading: fields as aligned `Label  value` lines, nested objects
 * indented under their label, and lists of objects as tables.
 */
function details(reply: unknown, indent = ""): string {
  if (Array.isArray(reply)) return list("", reply, indent);
  if (!isRecord(reply)) return `${indent}${scalar("", reply)}`;
  const entries = Object.entries(reply).filter(([, value]) => value !== undefined);
  const nestedValue = (value: unknown) =>
    isRecord(value) || (Array.isArray(value) && value.some(isRecord));
  const flat = entries.filter(([, value]) => !nestedValue(value));
  const nested = entries.filter(([, value]) => nestedValue(value));
  const width = Math.max(0, ...flat.map(([key]) => label(key).length)) + 2;
  const lines = flat.map(([key, value]) => {
    const shown = Array.isArray(value)
      ? value.length
        ? value.join(", ")
        : out.dim("—")
      : scalar(key, value);
    return `${indent}${out.dim(label(key).padEnd(width))}${shown}`;
  });
  const blocks = nested.map(([key, value]) =>
    Array.isArray(value)
      ? list(key, value, indent)
      : `${indent}${out.bold(label(key))}\n${details(value, `${indent}  `)}`,
  );
  return [lines.join("\n"), ...blocks].filter(Boolean).join("\n\n");
}

/** A list of objects as a table of their scalar fields (at most six), under its label. */
function list(key: string, rows: unknown[], indent: string): string {
  const title = key ? `${indent}${out.bold(label(key))} ${out.dim(`(${rows.length})`)}\n` : "";
  const objects = rows.filter(isRecord);
  if (objects.length < rows.length) return `${title}${indent}${rows.map(String).join(", ")}`;
  const keys = [...new Set(objects.flatMap(Object.keys))]
    .filter((field) => objects.every((row) => !isRecord(row[field]) && !Array.isArray(row[field])))
    .slice(0, 6);
  const body = table(
    objects,
    keys.map(
      (field): Column<Record<string, unknown>> => [label(field).toUpperCase(), (row) => row[field]],
    ),
  );
  return (
    title +
    body
      .split("\n")
      .map((line) => indent + line)
      .join("\n")
  );
}

export const percent = (value: number | undefined) =>
  value === undefined ? "" : `${value.toFixed(1)}%`;
export const usd = (value: number | undefined) =>
  value === undefined ? "" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
