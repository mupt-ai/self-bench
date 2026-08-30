import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import React from "react";
import type { ExportTask } from "./types";

export default function TaskPanel({
  task,
  removed,
  onToggle,
}: {
  task: ExportTask;
  removed: boolean;
  onToggle: () => void;
}) {
  const definition = parseJson(task.textFiles.get("definition.json"));
  return (
    <article className="task-detail surface">
      <div className="detail-header">
        <div>
          <p className="eyebrow">TASK</p>
          <h2>{task.taskId}</h2>
          <p className="muted">
            {String(definition?.difficulty ?? "unknown")} · {String(definition?.repo ?? "")}
          </p>
        </div>
        <button
          type="button"
          className={`button ${removed ? "undo" : "danger"}`}
          onClick={onToggle}
        >
          {removed ? "Keep task" : "Mark for removal"}
        </button>
      </div>
      <DetailBlock title="Prompt">
        <pre>
          {String(definition?.prompt ?? task.textFiles.get("instruction.md") ?? "No prompt")}
        </pre>
      </DetailBlock>
      <DetailBlock title="Task definition">
        <pre>{task.textFiles.get("definition.json") ?? "Missing definition.json"}</pre>
      </DetailBlock>
      <DetailBlock title="Gold patch">
        <PatchBlock patch={task.textFiles.get("solution/gold.patch")} />
      </DetailBlock>
      <DetailBlock title="Held-out test patch">
        <PatchBlock patch={task.textFiles.get("tests/test.patch")} />
      </DetailBlock>
    </article>
  );
}

function PatchBlock({ patch }: { patch: string | undefined }) {
  if (!patch) return <pre>Missing patch</pre>;
  return (
    <DiffErrorBoundary key={patch} fallback={patch}>
      <RenderedPatch patch={patch} />
    </DiffErrorBoundary>
  );
}

function RenderedPatch({ patch }: { patch: string }) {
  const files = React.useMemo(
    () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    [patch],
  );
  if (!files.length) return <pre>{patch}</pre>;
  const options = {
    themeType: window.matchMedia("(prefers-color-scheme: dark)").matches
      ? ("dark" as const)
      : ("light" as const),
    diffStyle: window.matchMedia("(max-width: 900px)").matches
      ? ("unified" as const)
      : ("split" as const),
    diffIndicators: "bars" as const,
    overflow: "scroll" as const,
    stickyHeader: true,
  };
  return (
    <div className="patch-files">
      {files.map((file) => (
        <FileDiff
          key={`${file.prevName ?? ""}:${file.name}`}
          fileDiff={file}
          disableWorkerPool
          options={options}
        />
      ))}
    </div>
  );
}

class DiffErrorBoundary extends React.Component<
  React.PropsWithChildren<{ fallback: string }>,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Pierre diff renderer failed", error);
  }

  render() {
    return this.state.failed ? <pre>{this.props.fallback}</pre> : this.props.children;
  }
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="detail-block">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function parseJson(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
