import React from "react";
import { sheetTable, tableCode } from "./viewer-ui";

/** A shell script or config with line numbers. */
export function Script({ text, wrap = false }: { text: string; wrap?: boolean }) {
  const lines = React.useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <pre className="overflow-x-auto py-3 font-mono text-sm leading-6 [counter-reset:line]">
      {lines.map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
          key={index}
          className={`block pr-4 text-foreground before:box-content before:mr-4 before:inline-block before:w-8 before:pl-3 before:text-right before:text-xs before:text-muted-foreground before:select-none before:content-[counter(line)] before:[counter-increment:line] hover:bg-muted ${wrap ? "max-w-[110ch] pl-15 -indent-15 whitespace-pre-wrap wrap-anywhere before:indent-0" : "whitespace-pre"}`}
        >
          {line || " "}
        </span>
      ))}
    </pre>
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
    <section className="panel shrink-0">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted px-4 py-2 text-xs font-semibold text-muted-foreground [&_b]:min-w-0 [&_b]:font-mono [&_b]:text-sm [&_b]:wrap-anywhere [&_b]:font-medium [&_b]:text-foreground [&_button]:h-8 [&_button]:text-xs">
        <span>{title}</span>
        {detail && <b>{detail}</b>}
        {right && (
          <span className="ml-auto inline-flex items-center gap-3 font-mono text-xs font-normal text-muted-foreground">
            {right}
          </span>
        )}
      </div>
      <div className={pad ? "px-4 py-3" : ""}>{children}</div>
    </section>
  );
}

export function KeyValueTable({ rows }: { rows: [string, React.ReactNode][] }) {
  if (rows.length === 0)
    return <p className="px-4 py-3 text-muted-foreground">Nothing recorded.</p>;
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
