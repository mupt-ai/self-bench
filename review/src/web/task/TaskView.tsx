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
    <div className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[140px_minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)] md:grid-rows-1">
      <aside
        className="flex min-h-0 flex-col border-r border-b border-line bg-bg md:border-b-0"
        aria-label="Files"
      >
        <div className="flex h-11 items-center gap-2.5 border-b border-line px-4">
          <span className="font-mono text-[10px] font-medium tracking-[0.14em] text-mint uppercase">
            Files
          </span>
          {files && (
            <span className="font-mono text-xs font-medium text-dim">{files.files.length}</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
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
      <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] [&_.sheet-body]:min-w-0 [&_.sheet-body]:px-4 md:[&_.sheet-body]:px-8 [&_.block-head]:h-auto [&_.block-head]:min-h-9 [&_.block-head]:flex-wrap [&_.block-head]:gap-y-2 [&_.block-head]:py-2 [&_.fullscreen]:grid-rows-[auto_minmax(0,1fr)] [&_.fullscreen-head]:h-auto [&_.fullscreen-head]:min-h-12 [&_.fullscreen-head]:flex-wrap [&_.fullscreen-head]:py-3 [&_.fullscreen-head]:break-all [&_.fullscreen-head_.kbd]:hidden sm:[&_.fullscreen-head_.kbd]:inline">
        <div
          className="tabs min-w-0 overflow-x-auto whitespace-nowrap [&_button]:shrink-0"
          role="tablist"
        >
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
