import type React from "react";
import { panel, panelHead, panelTitle, rail, railLabel, railToggle } from "./viewer-ui";

export function FilesPanel({
  collapsed,
  onToggle,
  count,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  count?: number;
  children?: React.ReactNode;
}) {
  if (collapsed) {
    return (
      <aside className={rail} aria-label="Files (Collapsed)">
        <button type="button" className={railToggle} onClick={onToggle} title="Show Files">
          ▸
        </button>
        <span className={railLabel}>Files{count !== undefined ? ` · ${count}` : ""}</span>
      </aside>
    );
  }
  return (
    <aside className={panel} aria-label="Files">
      <div className={panelHead}>
        <span className={panelTitle}>Files {count !== undefined && <b>{count}</b>}</span>
        <button type="button" className={railToggle} onClick={onToggle} title="Hide Files">
          ◂
        </button>
      </div>
      <div className="min-h-0 overflow-auto">{children}</div>
    </aside>
  );
}
