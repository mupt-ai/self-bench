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
  files: TaskFileEntry[];
  current: string | null;
  onOpen: (path: string) => void;
}) {
  const root = React.useMemo(() => buildTree(files), [files]);
  return (
    <ul className="list-none py-1.5 site:font-mono">
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
  if (node.file) {
    const binary = node.file.text === undefined;
    return (
      <li>
        <button
          type="button"
          className={`flex w-full min-w-0 cursor-pointer justify-between gap-2.5 py-1.5 pr-4 pl-[calc(18px+var(--depth)*16px)] text-left text-[13px] text-(--fg-2) hover:bg-(--accent) hover:text-(--foreground) aria-current:bg-(--accent) aria-current:text-(--foreground) aria-current:shadow-[inset_2px_0_0_var(--brand)] [&_span:first-child]:min-w-0 [&_span:first-child]:truncate site:pl-[calc(20px+var(--depth)*14px)] site:font-mono site:text-sm site:leading-[normal] site:text-muted site:hover:bg-surface site:hover:text-ink site:aria-current:bg-surface-2 site:aria-current:text-mint-bright ${binary ? "text-(--faint)! site:text-dim!" : ""}`}
          style={style}
          aria-current={current === node.path}
          onClick={() => onOpen(node.path)}
          title={node.path}
        >
          <span>{node.name}</span>
          <span className="shrink-0 text-[11px] text-(--muted-fg) site:text-sm site:leading-[normal] site:text-dim">
            {formatBytes(node.file.sizeBytes)}
          </span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <div
        className="mt-1.5 flex items-center gap-2 pt-1.5 pr-4 pb-1 pl-[calc(18px+var(--depth)*14px)] text-[11px] tracking-[0.16em] text-(--muted-fg) uppercase site:mt-1 site:block site:pt-2 site:pl-[calc(20px+var(--depth)*14px)] site:font-mono site:text-sm site:font-medium site:leading-[normal] site:tracking-[0.14em] site:text-dim"
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

function buildTree(files: TaskFileEntry[]): Node {
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
