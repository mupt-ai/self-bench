import React from "react";
import { formatTime, keyTail } from "../lib/format";
import { buildTaskModel } from "../lib/task-model";
import { EnvironmentSheet } from "../sheets/EnvironmentSheet";
import { FileSheet, type OpenFile } from "../sheets/FileSheet";
import { PipelineSheet } from "../sheets/PipelineSheet";
import type { TaskSource } from "../sources/types";
import type { CandidateArtifacts, TaskFiles, TaskRow } from "../types";
import { FileTree } from "./FileTree";
import { Stamp, stageLabel, toneFor } from "./Stamp";

type Tab = "environment" | "pipeline" | "file";
const TAIL_THRESHOLD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const DEFAULT_FILES = ["instruction.md", "task.toml", "definition.json"];

export function Workbench({
  source,
  row,
  filesCollapsed,
  onToggleFiles,
}: {
  source: TaskSource;
  row: TaskRow;
  filesCollapsed: boolean;
  onToggleFiles: () => void;
}) {
  const [files, setFiles] = React.useState<TaskFiles | null>(null);
  const [artifacts, setArtifacts] = React.useState<CandidateArtifacts | null>(null);
  const [bundleKey, setBundleKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>(() => initialTab());
  const [openFile, setOpenFile] = React.useState<OpenFile | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setArtifacts(null);
    setBundleKey(null);
    setError(null);
    setOpenFile(null);
    const load = async () => {
      try {
        if (source.artifacts) {
          const found = await source.artifacts(row.id);
          if (cancelled) return;
          setArtifacts(found);
          const first = found.bundles[0];
          if (first && source.loadBundle) {
            setBundleKey(first.key);
            const loaded = await source.loadBundle(first.key);
            if (!cancelled) setFiles(loaded);
          } else {
            setFiles({ taskId: row.id, files: [] });
            setTab((current) => (current === "environment" ? "pipeline" : current));
          }
        } else {
          const loaded = await source.loadFiles(row.id);
          if (!cancelled) setFiles(loaded);
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

  // The file view is the home screen: open the instruction (or the first text file) on load.
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

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set("tab", tab);
    window.history.replaceState(null, "", `#${params.toString()}`);
  }, [tab]);

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

  const tabs: [Tab, string, boolean][] = [
    ["file", openFile ? `File · ${openFile.path.split("/").pop()}` : "File", true],
    ["environment", "Environment", true],
    ["pipeline", "Pipeline", Boolean(source.artifacts)],
  ];

  return (
    <>
      <FilesPanel collapsed={filesCollapsed} onToggle={onToggleFiles} count={files?.files.length}>
        {files ? (
          files.files.length === 0 ? (
            <p className="notice">no bundle files for this candidate</p>
          ) : (
            <FileTree files={files.files} current={openFile?.path ?? null} onOpen={openPath} />
          )
        ) : error ? (
          <p className="notice bad">{error}</p>
        ) : (
          <p className="loading">loading files</p>
        )}
      </FilesPanel>
      <div className="sheet">
        <div className="task-head">
          <h1>{row.id}</h1>
          {row.difficulty && <Stamp>{row.difficulty}</Stamp>}
          {(row.stage || row.status) && (
            <Stamp tone={toneFor(row.stage, row.status)} big>
              {stageLabel(row.stage, row.status)}
            </Stamp>
          )}
          {row.reasonSummary && (
            <span className="meta reason" title={row.reason}>
              {row.reasonSummary}
            </span>
          )}
          {row.sourcePr ? (
            <span className="meta">
              PR{" "}
              <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                #{row.sourcePr}
              </a>
            </span>
          ) : null}
          {row.runner && (
            <span className="meta">
              runner <b className="mono">{row.runner}</b>
              {row.failToPass !== undefined && (
                <>
                  {" · "}
                  <b>{row.failToPass}</b> f2p · <b>{row.passToPass ?? 0}</b> p2p
                </>
              )}
            </span>
          )}
          <span className="grow" />
          {artifacts && artifacts.bundles.length > 0 && (
            <label className="meta">
              bundle{" "}
              <select
                className="field"
                value={bundleKey ?? ""}
                onChange={(event) => void switchBundle(event.target.value)}
              >
                {artifacts.bundles.map((bundle) => (
                  <option key={bundle.key} value={bundle.key}>
                    {bundle.stage} · {keyTail(bundle.key, 3)}
                    {bundle.updatedAt ? ` · ${formatTime(bundle.updatedAt)}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="tabs" role="tablist">
          {tabs.map(([key, label, enabled]) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === key}
              disabled={!enabled}
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
          <p className="loading">loading bundle</p>
        ) : (
          <EnvironmentSheet model={model} onOpenFile={openPath} />
        )}
      </div>
    </>
  );
}

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
      <aside className="panel rail" aria-label="Files (collapsed)">
        <button type="button" className="rail-toggle" onClick={onToggle} title="Show files">
          ▸
        </button>
        <span className="rail-label">files{count !== undefined ? ` · ${count}` : ""}</span>
      </aside>
    );
  }
  return (
    <aside className="panel files" aria-label="Files">
      <div className="panel-head">
        <span className="panel-title">files {count !== undefined && <b>{count}</b>}</span>
        <button type="button" className="rail-toggle" onClick={onToggle} title="Hide files">
          ◂
        </button>
      </div>
      <div className="panel-body">{children}</div>
    </aside>
  );
}

function initialTab(): Tab {
  const wanted = new URLSearchParams(window.location.hash.slice(1)).get("tab");
  const tabs: Tab[] = ["file", "environment", "pipeline"];
  return tabs.find((candidate) => candidate === wanted) ?? "file";
}
