import React from "react";
import { sheetTable, tableCode } from "./viewer-ui";

/** A shell script or config with line numbers; `highlight` marks lines to emphasize. */
export function Script({
  text,
  highlight,
  placeholder,
  wrap = false,
}: {
  text: string;
  highlight?: (line: string) => boolean;
  placeholder?: string;
  wrap?: boolean;
}) {
  const lines = React.useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <pre className="overflow-x-auto py-3 font-mono text-sm leading-6 [counter-reset:line]">
      {lines.map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
          key={index}
          className={`block pr-4 text-foreground before:box-content before:mr-4 before:inline-block before:w-8 before:pl-3 before:text-right before:text-xs before:text-muted-foreground before:select-none before:content-[counter(line)] before:[counter-increment:line] hover:bg-muted ${wrap ? "max-w-[110ch] pl-15 -indent-15 whitespace-pre-wrap wrap-anywhere before:indent-0" : "whitespace-pre"} ${highlight?.(line) ? "bg-brand/10" : ""}`}
        >
          {placeholder ? emphasize(line, placeholder) : line || " "}
        </span>
      ))}
    </pre>
  );
}

function emphasize(line: string, token: string): React.ReactNode {
  const parts = line.split(token);
  if (parts.length === 1) return line || " ";
  return parts.flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          // biome-ignore lint/suspicious/noArrayIndexKey: split segments are positional
          <span key={index} className="font-semibold text-(--brand) site:text-brand">
            {token}
          </span>,
          part,
        ],
  );
}

export function Block({
  title,
  detail,
  right,
  children,
  pad,
}: {
  title: string;
  detail?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  pad?: boolean;
}) {
  return (
    <section className="shrink-0 border border-(--border) bg-(--card)">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/50 px-4 py-2 text-xs tracking-wider text-muted-foreground uppercase [&_b]:text-sm [&_b]:font-medium [&_b]:tracking-normal [&_b]:text-foreground [&_b]:normal-case [&_button]:h-8 [&_button]:text-xs">
        <span>{title}</span>
        {detail && <b>{detail}</b>}
        {right && (
          <span className="ml-auto inline-flex items-center gap-3 text-xs font-normal tracking-normal text-muted-foreground normal-case">
            {right}
          </span>
        )}
      </div>
      <div className={pad ? "px-4 py-3" : ""}>{children}</div>
    </section>
  );
}

export function KeyValueTable({ rows }: { rows: [string, React.ReactNode][] }) {
  if (rows.length === 0) return <p className="px-4 py-3 text-(--muted-fg)">nothing recorded</p>;
  return (
    <table className={sheetTable}>
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <th>{key}</th>
            <td className={tableCode}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
