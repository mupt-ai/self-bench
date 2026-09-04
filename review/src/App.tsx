import React from "react";
import { Masthead, type Mode } from "./components/Masthead";
import { Register } from "./components/Register";
import { FilesPanel, Workbench } from "./components/Workbench";
import { openLocalSource } from "./sources/local";
import { openRunSource } from "./sources/run";
import { createApiClient, type TaskSource } from "./sources/types";
import type { RunSummary, ViewerInfo } from "./types";

export function App() {
  const [info, setInfo] = React.useState<ViewerInfo | null>(null);
  const [needsToken, setNeedsToken] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("runs");
  const [runs, setRuns] = React.useState<RunSummary[]>([]);
  const [runId, setRunId] = React.useState("");
  const [source, setSource] = React.useState<TaskSource | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = usePersistedFlag("ledger.tasks.collapsed");
  const [filesCollapsed, setFilesCollapsed] = usePersistedFlag("ledger.files.collapsed");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const api = React.useMemo(() => createApiClient(token), [token]);

  const guard = React.useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshRuns = React.useCallback(
    () =>
      guard(async () => {
        setRuns(await api.json<RunSummary[]>("/v1/runs"));
      }),
    [api, guard],
  );

  // The server decides the mode: a local directory server offers "local", the API offers "runs".
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/v1/viewer");
        if (response.status === 401) {
          if (!cancelled) setNeedsToken(true);
          return;
        }
        const found = (await response.json()) as ViewerInfo;
        if (cancelled) return;
        setInfo(found);
        if (found.modes.includes("local")) {
          setMode("local");
          setSource(await openLocalSource(createApiClient(""), found.root ?? "."));
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (mode === "runs" && (info?.modes.includes("runs") || (needsToken && token))) {
      void refreshRuns();
    }
  }, [mode, info, needsToken, token, refreshRuns]);

  // Only the most recent run request may install its rows: a slow load that resolves
  // after the picker was cleared or switched would otherwise refill the register.
  const runRequest = React.useRef(0);
  const openRun = React.useCallback(
    (nextRunId: string) => {
      const request = ++runRequest.current;
      setRunId(nextRunId);
      setSelectedId(null);
      if (!nextRunId) {
        // Clearing the picker drops the run's rows and its deep link, so the
        // run-from-hash effect below cannot reopen the run we just closed.
        setSource(null);
        writeHash((params) => {
          params.delete("run");
          params.delete("task");
        });
        return;
      }
      void guard(async () => {
        const opened = await openRunSource(api, nextRunId);
        if (runRequest.current === request) setSource(opened);
      });
    },
    [api, guard],
  );

  // Deep links: #run=<id> opens a run once the run list is known.
  React.useEffect(() => {
    if (mode !== "runs" || runId || runs.length === 0) return;
    const wanted = new URLSearchParams(window.location.hash.slice(1)).get("run");
    if (wanted && runs.some((run) => run.runId === wanted)) openRun(wanted);
  }, [mode, runId, runs, openRun]);

  const rows = source?.rows ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  // Deep links: #task=<id> selects a row once its source is loaded, and selecting updates the hash.
  React.useEffect(() => {
    if (!source || selectedId) return;
    const wanted = new URLSearchParams(window.location.hash.slice(1)).get("task");
    if (wanted && source.rows.some((row) => row.id === wanted)) setSelectedId(wanted);
  }, [source, selectedId]);
  React.useEffect(() => {
    if (!source) return;
    writeHash((params) => {
      if (selectedId) params.set("task", selectedId);
      else params.delete("task");
      if (runId) params.set("run", runId);
      else params.delete("run");
    });
  }, [selectedId, runId, source]);

  return (
    <div className="ledger">
      <Masthead
        info={info}
        needsToken={needsToken}
        mode={mode}
        runs={runs}
        runId={runId}
        onRun={openRun}
        onRefreshRuns={() => void refreshRuns()}
        token={token}
        onToken={setToken}
        source={source}
        busy={busy}
        error={error}
      />
      <div
        className={`deck ${collapsed ? "tasks-collapsed" : ""} ${filesCollapsed ? "files-collapsed" : ""}`}
      >
        <Register
          rows={rows}
          selectedId={selectedId}
          onSelect={setSelectedId}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed(!collapsed)}
        />
        {source && selected ? (
          <Workbench
            key={`${source.label}:${selected.id}`}
            source={source}
            row={selected}
            filesCollapsed={filesCollapsed}
            onToggleFiles={() => setFilesCollapsed(!filesCollapsed)}
          />
        ) : (
          <>
            <FilesPanel
              collapsed={filesCollapsed}
              onToggle={() => setFilesCollapsed(!filesCollapsed)}
            />
            <div className="sheet">
              <p className="workbench-empty">
                {source
                  ? "Select a task on the left to open its Harbor environment."
                  : needsToken && !token
                    ? "Enter the API token to list runs."
                    : "Pick a run to list its candidates."}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Rewrite the location hash in place, leaving history untouched. */
function writeHash(update: (params: URLSearchParams) => void): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  update(params);
  const next = params.toString();
  if (next !== window.location.hash.slice(1)) {
    window.history.replaceState(null, "", next ? `#${next}` : window.location.pathname);
  }
}

function usePersistedFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const update = React.useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // storage unavailable; the flag lives for this page only
      }
    },
    [key],
  );
  return [value, update];
}
