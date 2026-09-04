import React from "react";

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
    <pre className={`script ${wrap ? "wrap" : ""}`}>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
        <span key={index} className={`ln ${highlight?.(line) ? "hl" : ""}`}>
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
          <span key={index} className="placeholder">
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
    <section className="block">
      <div className="block-head">
        <span>{title}</span>
        {detail && <b>{detail}</b>}
        {right && <span className="right">{right}</span>}
      </div>
      <div className={`block-body ${pad ? "pad" : ""}`}>{children}</div>
    </section>
  );
}

export function KeyValueTable({ rows }: { rows: [string, React.ReactNode][] }) {
  if (rows.length === 0) return <p className="muted">nothing recorded</p>;
  return (
    <table className="sheet-table">
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key}>
            <th>{key}</th>
            <td className="code">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
