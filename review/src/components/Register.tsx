import React from "react";
import type { TaskRow } from "../types";
import { toneFor } from "./Stamp";

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
      <aside className="panel rail" aria-label="Task register (collapsed)">
        <button
          type="button"
          className="rail-toggle"
          onClick={props.onToggleCollapsed}
          title="Show tasks"
        >
          ▸
        </button>
        <span className="rail-label">tasks · {props.rows.length}</span>
      </aside>
    );
  }

  return (
    <aside className="panel register" aria-label="Task register">
      <div className="panel-head">
        <span className="panel-title">
          tasks <b>{visible.length}</b>
          {visible.length !== props.rows.length && (
            <span className="dim"> of {props.rows.length}</span>
          )}
        </span>
        <button
          type="button"
          className="rail-toggle"
          onClick={props.onToggleCollapsed}
          title="Hide tasks"
        >
          ◂
        </button>
      </div>
      <div className="panel-tools">
        <input
          className="field wide"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="filter"
          aria-label="Filter tasks"
        />
        {stageCounts.length > 1 && (
          <div className="chips wrap">
            {stageCounts.map(([stage, count]) => (
              <button
                key={stage}
                type="button"
                className="chip"
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
        className="register-scroll"
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
          <p className="empty">Nothing to show.</p>
        ) : (
          <ul className="task-list">
            {visible.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={`task-row tone-${toneFor(row.stage, row.status) || "none"}`}
                  aria-current={row.id === props.selectedId}
                  onClick={() => props.onSelect(row.id)}
                  title={row.reasonSummary ?? row.name}
                >
                  <span className="dot" aria-hidden="true" />
                  <span className="name">{row.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
