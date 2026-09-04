import React from "react";
import { FileTree } from "../../components/FileTree";
import { formatTime, keyTail } from "../../lib/format";
import { buildTaskModel } from "../../lib/task-model";
import { EnvironmentSheet } from "../../sheets/EnvironmentSheet";
import { FileSheet, type OpenFile } from "../../sheets/FileSheet";
import { PipelineSheet } from "../../sheets/PipelineSheet";
import type { TaskSource } from "../../sources/types";
import type { CandidateArtifacts, TaskFiles, TaskRow } from "../../types";

type Tab = "file" | "environment" | "pipeline";
const TAIL_THRESHOLD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const DEFAULT_FILES = ["instruction.md", "task.toml", "definition.json"];

/** The file review: bundle tree on the left, file / environment / pipeline on the right. */
export function TaskView({ source, row }: { source: TaskSource; row: TaskRow }) {
  const [files, setFiles] = React.useState<TaskFiles | null>(null);
  const [artifacts, setArtifacts] = React.useState<CandidateArtifacts | null>(null);
  const [bundleKey, setBundleKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("file");
  const [openFile, setOpenFile] = React.useState<OpenFile | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const found = await source.artifacts?.(row.id);
        if (cancelled) return;
        if (found) setArtifacts(found);
        const first = found?.bundles[0];
        if (first && source.loadBundle) {
          setBundleKey(first.key);
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

  const switchBundle = async (key: string) => {
    if (!source.loadBundle) return;
    setBundleKey(key);
    setFiles(null);
    setError(null);
    try {
      setFiles(await source.loadBundle(key));
      setOpenFile(null);
      setTab("file");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

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

  const openArtifact = async (key: string, sizeBytes: number, full = false) => {
    if (!source.readArtifact) return;
    const path = keyTail(key, 4);
    const partial = !full && key.endsWith(".log") && sizeBytes > TAIL_THRESHOLD_BYTES;
    setOpenFile({ path, loading: true });
    setTab("file");
    try {
      const start = partial ? sizeBytes - TAIL_BYTES : 0;
      const text = await source.readArtifact(key, start > 0 ? { start } : undefined);
      setOpenFile({
        path,
        text: partial ? text.slice(text.indexOf("\n") + 1) : text,
        sizeBytes,
        ...(partial
          ? {
              tail: {
                shownBytes: TAIL_BYTES,
                loadFull: () => void openArtifact(key, sizeBytes, true),
              },
            }
          : {}),
      });
    } catch (cause) {
      setOpenFile({ path: key, error: cause instanceof Error ? cause.message : String(cause) });
    }
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
        {artifacts && artifacts.bundles.length > 1 && (
          <select
            className="task-bundle"
            value={bundleKey ?? ""}
            onChange={(event) => void switchBundle(event.target.value)}
            aria-label="Bundle"
          >
            {artifacts.bundles.map((bundle) => (
              <option key={bundle.key} value={bundle.key}>
                {bundle.stage} · {keyTail(bundle.key, 3)}
                {bundle.updatedAt ? ` · ${formatTime(bundle.updatedAt)}` : ""}
              </option>
            ))}
          </select>
        )}
        <div className="task-files-body">
          {files ? (
            files.files.length === 0 ? (
              <p className="notice">No bundle files for this task.</p>
            ) : (
              <FileTree files={files.files} current={openFile?.path ?? null} onOpen={openPath} />
            )
          ) : error ? (
            <p className="notice bad">{error}</p>
          ) : (
            <p className="loading">
              Expanding the task bundle. Large bundles take a minute the first time.
            </p>
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
          <PipelineSheet
            source={source}
            row={row}
            artifacts={artifacts}
            onOpenArtifact={(key, sizeBytes) => void openArtifact(key, sizeBytes)}
            onOpenBundle={(key) => void switchBundle(key)}
          />
        ) : tab === "file" ? (
          <FileSheet key={openFile?.path ?? ""} file={openFile} />
        ) : !model ? (
          <p className="loading">Loading bundle</p>
        ) : (
          <EnvironmentSheet model={model} onOpenFile={openPath} />
        )}
      </section>
    </div>
  );
}
