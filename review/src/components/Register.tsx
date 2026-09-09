import React from "react";
import type { TaskRow } from "../types";
import { toneFor } from "./Stamp";
import {
  panel,
  panelHead,
  panelTitle,
  rail,
  railLabel,
  railToggle,
  viewerField,
} from "./viewer-ui";

const STAGE_ORDER = [
  "accepted",
  "in_progress",
  "authoring",
  "environment",
  "audit",
  "preflight",
  "validation",
  "review",
  "infrastructure",
];

export interface RegisterProps {
  rows: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/** The task list: a collapsible left panel showing one name per row. */
export function Register(props: RegisterProps) {
  const [query, setQuery] = React.useState("");
  const [stages, setStages] = React.useState<Set<string>>(new Set());

  const stageCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of props.rows) {
      const stage = row.stage ?? row.status ?? "";
      if (stage) counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    return [...counts.entries()].sort(
      (left, right) => STAGE_ORDER.indexOf(left[0]) - STAGE_ORDER.indexOf(right[0]),
    );
  }, [props.rows]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return props.rows.filter((row) => {
      if (stages.size > 0 && !stages.has(row.stage ?? row.status ?? "")) return false;
      if (!needle) return true;
      return [row.id, row.name, row.runner, row.testCommand, row.reasonSummary, row.path]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [props.rows, query, stages]);

  const move = (delta: number) => {
    const index = visible.findIndex((row) => row.id === props.selectedId);
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))];
    if (next) props.onSelect(next.id);
  };

  if (props.collapsed) {
    return (
      <aside className={rail} aria-label="Task Register (Collapsed)">
        <button
          type="button"
          className={railToggle}
          onClick={props.onToggleCollapsed}
          title="Show Tasks"
        >
          ▸
        </button>
        <span className={railLabel}>Tasks · {props.rows.length}</span>
      </aside>
    );
  }

  return (
    <aside className={`${panel} grid-rows-[44px_auto_minmax(0,1fr)]!`} aria-label="Task Register">
      <div className={panelHead}>
        <span className={panelTitle}>
          Tasks <b>{visible.length}</b>
          {visible.length !== props.rows.length && (
            <span className="text-(--faint) tracking-normal normal-case">
              {" "}
              of {props.rows.length}
            </span>
          )}
        </span>
        <button
          type="button"
          className={railToggle}
          onClick={props.onToggleCollapsed}
          title="Hide Tasks"
        >
          ◂
        </button>
      </div>
      <div className="flex flex-col gap-3.5 border-b border-(--border) py-3.5 pr-4 pl-5">
        <input
          className={`${viewerField} w-full !min-w-0`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter"
          aria-label="Filter Tasks"
        />
        {stageCounts.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] flex-wrap overflow-visible">
            {stageCounts.map(([stage, count]) => (
              <button
                key={stage}
                type="button"
                className="inline-flex items-baseline gap-[7px] border border-(--border) bg-(--card) px-[9px] py-1 text-xs whitespace-nowrap text-(--muted-fg) capitalize hover:border-(--brand-dark) hover:text-(--foreground) aria-pressed:border-(--brand-40) aria-pressed:bg-(--brand-10) aria-pressed:text-(--brand) [&_b]:font-medium [&_b]:text-(--fg-2) aria-pressed:[&_b]:text-(--brand)"
                aria-pressed={stages.has(stage)}
                onClick={() =>
                  setStages((current) => {
                    const next = new Set(current);
                    if (next.has(stage)) next.delete(stage);
                    else next.add(stage);
                    return next;
                  })
                }
              >
                {stage.replace(/_/g, " ")}
                <b>{count}</b>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the scroll region owns keyboard row navigation */}
      <div
        className="min-h-0 overflow-auto outline-none"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so arrow keys move the selection
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        {visible.length === 0 ? (
          <p className="px-5 py-4 text-(--muted-fg)">Nothing to show.</p>
        ) : (
          <ul className="list-none">
            {visible.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="group flex w-full min-w-0 cursor-pointer items-center gap-3 border-b border-(--border-soft) py-2 pr-3.5 pl-5 text-left text-[13px] text-(--fg-2) hover:bg-(--accent) hover:text-(--foreground) aria-current:bg-(--accent) aria-current:text-(--foreground) aria-current:shadow-[inset_2px_0_0_var(--brand)]"
                  aria-current={row.id === props.selectedId}
                  onClick={() => props.onSelect(row.id)}
                  title={row.reasonSummary ?? row.name}
                >
                  <span
                    className={`size-1.5 shrink-0 ${{ ok: "bg-(--ok)", bad: "bg-(--bad)", warn: "bg-(--brand-dark)", live: "bg-(--brand)", "": "bg-(--border)" }[toneFor(row.stage, row.status)]}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate group-aria-current:font-medium">{row.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
