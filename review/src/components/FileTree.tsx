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
    <ul className="tree">
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
          className={`file ${binary ? "binary" : ""}`}
          style={style}
          aria-current={current === node.path}
          onClick={() => onOpen(node.path)}
          title={node.path}
        >
          <span>{node.name}</span>
          <span className="size">{formatBytes(node.file.sizeBytes)}</span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <div className="dir" style={style}>
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
