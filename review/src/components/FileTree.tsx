import React from "react";
import { formatBytes } from "../lib/format";
import type { TaskFileEntry } from "../types";

interface Node {
  name: string;
  path: string;
  children: Node[];
  file?: TaskFileEntry;
}

export function FileTree({
  files,
  current,
  onOpen,
}: {
  files: readonly TaskFileEntry[];
  current: string | null;
  onOpen: (path: string) => void;
}) {
  const root = React.useMemo(() => buildTree(files), [files]);
  const list = React.useRef<HTMLUListElement>(null);
  const shown = React.useRef(current);
  // In a list too short to show every file, a file opened from elsewhere scrolls into view. The
  // first one shown does not, so the list starts at its top, folders and all.
  React.useEffect(() => {
    const previous = shown.current;
    shown.current = current;
    if (!previous || previous === current) return;
    const row = list.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (row) revealInList(row);
  }, [current]);
  return (
    <ul ref={list} className="list-none py-2 font-mono">
      {root.children.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} current={current} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  current,
  onOpen,
}: {
  node: Node;
  depth: number;
  current: string | null;
  onOpen: (path: string) => void;
}) {
  const style = { "--depth": depth } as React.CSSProperties;
  const chosen = current === node.path;
  if (node.file) {
    const binary = node.file.text === undefined;
    return (
      <li>
        <button
          type="button"
          className={`flex min-h-8 touch:min-h-11 w-full min-w-0 cursor-pointer items-center justify-between gap-2 border-l-2 border-transparent py-1 pr-4 pl-[calc(14px+var(--depth)*14px)] text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-current:border-foreground aria-current:bg-foreground/[0.06] aria-current:font-medium aria-current:text-foreground [&_span:first-child]:min-w-0 [&_span:first-child]:truncate ${binary ? "opacity-50" : ""}`}
          style={style}
          aria-current={chosen}
          onClick={() => onOpen(node.path)}
          title={node.path}
        >
          <span>{node.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatBytes(node.file.sizeBytes)}
          </span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <div
        className="mt-2 px-4 py-1 pl-[calc(16px+var(--depth)*14px)] text-xs font-semibold text-muted-foreground"
        style={style}
      >
        {node.name}/
      </div>
      <ul>
        {node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            current={current}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </li>
  );
}

function buildTree(files: readonly TaskFileEntry[]): Node {
  const root: Node = { name: "", path: "", children: [] };
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const parts = file.path.split("/");
    let cursor = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let next = cursor.children.find((child) => child.name === part && !child.file);
      if (index === parts.length - 1) {
        cursor.children.push({ name: part, path, children: [], file });
        return;
      }
      if (!next) {
        next = { name: part, path, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    });
  }
  const order = (node: Node): void => {
    node.children.sort((left, right) => {
      if (Boolean(left.file) !== Boolean(right.file)) return left.file ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
    for (const child of node.children) order(child);
  };
  order(root);
  return root;
}

/**
 * Scrolls the list a row is in, and nothing around it, until the row shows: `scrollIntoView`
 * would also move a page or grid that hides its overflow, which no one could scroll back.
 */
function revealInList(row: HTMLElement): void {
  let list = row.parentElement;
  while (list && !/auto|scroll/.test(getComputedStyle(list).overflowY)) list = list.parentElement;
  if (!list) return;
  const shown = list.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top < shown.top) list.scrollTop -= shown.top - box.top;
  else if (box.bottom > shown.bottom) list.scrollTop += box.bottom - shown.bottom;
}
