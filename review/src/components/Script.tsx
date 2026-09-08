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
    <pre
      className={`overflow-x-auto pt-3 pb-3.5 font-mono text-[13px] [counter-reset:line] site:leading-[normal] ${wrap ? "site:text-base" : "site:text-sm"}`}
    >
      {lines.map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
          key={index}
          className={`block pr-6 leading-[25px] text-(--fg-2) before:box-content before:mr-4.5 before:inline-block before:w-10 before:pl-3 before:text-right before:text-xs before:leading-[25px] before:text-[hsl(30_5%_32%)] before:select-none before:content-[counter(line)] before:[counter-increment:line] hover:bg-(--viewer-panel) site:leading-6 site:text-ink site:before:text-sm site:before:leading-6 site:before:text-dim site:hover:bg-surface-2 ${wrap ? "max-w-[110ch] pl-[70px] -indent-[70px] whitespace-pre-wrap wrap-anywhere before:indent-0" : "whitespace-pre"} ${highlight?.(line) ? "bg-(--brand-10) site:bg-mint/10" : ""}`}
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
          <span key={index} className="font-semibold text-(--brand) site:text-mint">
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
      <div className="flex h-10 items-baseline gap-2.5 border-b border-(--border) bg-(--viewer-panel) px-4 text-[11px] leading-10 tracking-[0.16em] text-(--muted-fg) uppercase [&_b]:text-[13px] [&_b]:font-medium [&_b]:tracking-normal [&_b]:text-(--foreground) [&_b]:normal-case site:h-auto site:min-h-9 site:flex-wrap site:items-center site:gap-y-2 site:px-3.5 site:py-2 site:font-mono site:text-sm site:font-medium site:leading-[normal] site:tracking-[0.12em] site:text-dim site:[&_b]:text-sm site:[&_button]:h-6 site:[&_button]:border site:[&_button]:border-line-strong site:[&_button]:px-2 site:[&_button]:text-muted site:[&_button]:leading-[normal] site:[&_button]:hover:border-mint site:[&_button]:hover:text-mint-bright site:[&_button]:hover:no-underline">
        <span>{title}</span>
        {detail && <b>{detail}</b>}
        {right && (
          <span className="ml-auto text-xs tracking-normal text-(--muted-fg) normal-case site:inline-flex site:items-center site:gap-3 site:font-mono site:text-sm site:font-normal site:leading-[normal] site:text-dim">
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
