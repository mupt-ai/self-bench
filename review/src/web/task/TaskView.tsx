import React from "react";
import { FileTree } from "../../components/FileTree";
import { buildTaskModel } from "../../lib/task-model";
import { AgentWorkSheet } from "../../sheets/AgentWorkSheet";
import { EnvironmentSheet } from "../../sheets/EnvironmentSheet";
import { FileSheet, type OpenFile } from "../../sheets/FileSheet";
import type { TaskSource } from "../../sources/types";
import type { TaskFiles, TaskRow } from "../../types";

type Tab = "file" | "environment" | "pipeline";
const DEFAULT_FILES = ["instruction.md", "task.toml", "definition.json"];

/** The file review: bundle tree on the left, file / environment / pipeline on the right. */
export function TaskView({ source, row }: { source: TaskSource; row: TaskRow }) {
  const [files, setFiles] = React.useState<TaskFiles | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("file");
  const [openFile, setOpenFile] = React.useState<OpenFile | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const found = await source.artifacts?.(row.id);
        if (cancelled) return;
        const first = found?.bundles[0];
        if (first && source.loadBundle) {
          const loaded = await source.loadBundle(first.key);
          if (!cancelled) setFiles(loaded);
        } else {
          setFiles({ taskId: row.id, files: [] });
          setTab("pipeline");
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [source, row.id]);

  const model = React.useMemo(() => (files ? buildTaskModel(files) : null), [files]);

  React.useEffect(() => {
    if (!files || openFile || tab !== "file") return;
    const first =
      DEFAULT_FILES.map((name) => files.files.find((file) => file.path === name)).find(Boolean) ??
      files.files.find((file) => file.text !== undefined);
    if (first) {
      setOpenFile({
        path: first.path,
        sizeBytes: first.sizeBytes,
        ...(first.text !== undefined ? { text: first.text } : {}),
      });
    }
  }, [files, openFile, tab]);

  const openPath = (path: string) => {
    const entry = model?.byPath.get(path);
    setOpenFile(
      entry
        ? {
            path,
            sizeBytes: entry.sizeBytes,
            ...(entry.text !== undefined ? { text: entry.text } : {}),
          }
        : { path, error: "file not in this bundle" },
    );
    setTab("file");
  };

  const tabs: [Tab, string][] = [
    ["file", openFile ? `File · ${openFile.path.split("/").pop()}` : "File"],
    ["environment", "Environment"],
    ["pipeline", "Pipeline"],
  ];

  return (
    <div className="task-body">
      <aside className="task-files" aria-label="Files">
        <div className="task-files-head">
          <span className="eyebrow">Files</span>
          {files && <span className="task-files-count">{files.files.length}</span>}
        </div>
        <div className="task-files-body">
          {files ? (
            files.files.length === 0 ? (
              <p className="notice">No files available yet.</p>
            ) : (
              <FileTree files={files.files} current={openFile?.path ?? null} onOpen={openPath} />
            )
          ) : error ? (
            <p className="notice bad">{error}</p>
          ) : (
            <p className="loading">Loading files…</p>
          )}
        </div>
      </aside>
      <section className="task-pane">
        <div className="tabs" role="tablist">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {error && tab !== "pipeline" ? (
          <p className="notice bad">{error}</p>
        ) : tab === "pipeline" ? (
          <AgentWorkSheet source={source} row={row} />
        ) : tab === "file" ? (
          <FileSheet key={openFile?.path ?? ""} file={openFile} />
        ) : !model ? (
          <p className="loading">Loading files…</p>
        ) : (
          <EnvironmentSheet model={model} onOpenFile={openPath} />
        )}
      </section>
    </div>
  );
}
