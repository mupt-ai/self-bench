import React from "react";
import { buildCleanExport, loadExport } from "./export-loader";
import type { LoadedExport, RunStatus, RunSummary } from "./types";

const TaskPanel = React.lazy(() => import("./TaskPanel"));

export function App() {
  const [runs, setRuns] = React.useState<RunSummary[]>([]);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<RunStatus | null>(null);
  const [loaded, setLoaded] = React.useState<LoadedExport | null>(null);
  const [removed, setRemoved] = React.useState<Set<string>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [token, setToken] = React.useState("");
  const fileInput = React.useRef<HTMLInputElement>(null);
  const apiFetch = React.useCallback(
    (path: string) =>
      fetch(path, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined),
    [token],
  );

  const refreshRuns = React.useCallback(async () => {
    try {
      setError(null);
      const response = await apiFetch("/v1/runs");
      if (!response.ok) throw new Error(`Unable to list runs (${response.status})`);
      setRuns((await response.json()) as RunSummary[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [apiFetch]);

  React.useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const openRun = async (nextRunId: string) => {
    try {
      setBusy(true);
      setError(null);
      setRunId(nextRunId);
      setLoaded(null);
      setRemoved(new Set());
      const [statusResponse, exportResponse] = await Promise.all([
        apiFetch(`/v1/runs/${encodeURIComponent(nextRunId)}`),
        apiFetch(`/v1/runs/${encodeURIComponent(nextRunId)}/export`),
      ]);
      if (!statusResponse.ok) throw new Error(`Unable to load run (${statusResponse.status})`);
      if (!exportResponse.ok) throw new Error(`Export is not ready (${exportResponse.status})`);
      setStatus((await statusResponse.json()) as RunStatus);
      setLoaded(await loadExport(await exportResponse.blob()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (file: File) => {
    try {
      setBusy(true);
      setError(null);
      const next = await loadExport(file);
      setLoaded(next);
      setRunId(next.manifest.runId);
      setStatus({
        runId: next.manifest.runId,
        phase: "local export",
        requested: next.manifest.acceptedCount,
        accepted: next.manifest.acceptedCount,
        rejected: 0,
        tasks: [],
      });
      setRemoved(new Set());
      setSelectedTaskId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectedTask =
    loaded?.tasks.find((task) => task.taskId === selectedTaskId) ?? loaded?.tasks[0];
  const toggleRemoved = (taskId: string) =>
    setRemoved((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  const downloadClean = async () => {
    if (!loaded || !runId) return;
    const blob = await buildCleanExport(loaded, removed);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `selfbench-${runId}-cleaned.tar.gz`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">SELFBENCH / EXPORT REVIEW</p>
          <h1>Review accepted tasks before publishing.</h1>
        </div>
        <div className="topbar-actions">
          <input
            className="token-input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="API token (session only)"
            aria-label="API token"
          />
          <input
            ref={fileInput}
            hidden
            type="file"
            accept=".gz,.tgz,application/gzip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openFile(file);
            }}
          />
          <button type="button" className="button" onClick={() => fileInput.current?.click()}>
            Open gzip
          </button>
          <button type="button" className="button" onClick={() => void refreshRuns()}>
            Refresh runs
          </button>
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <section className="workspace">
        <aside className="run-list surface">
          <div className="section-heading">
            <h2>Runs</h2>
            <span>{runs.length}</span>
          </div>
          {runs.length === 0 && <p className="muted">No runs found.</p>}
          {runs.map((run) => (
            <button
              type="button"
              className={`run-row ${run.runId === runId ? "selected" : ""}`}
              key={run.runId}
              onClick={() => void openRun(run.runId)}
            >
              <strong>{run.runId}</strong>
              <span>{run.status}</span>
              <small>{new Date(run.startedAt).toLocaleString()}</small>
            </button>
          ))}
        </aside>
        <section className="content">
          {!loaded && (
            <div className="empty surface">
              <h2>{busy ? "Loading export…" : "Select a completed run"}</h2>
              <p>Choose a run or open a local export gzip to inspect its accepted tasks.</p>
            </div>
          )}
          {loaded && status && (
            <>
              <div className="summary surface">
                <div>
                  <p className="eyebrow">{loaded.manifest.repository.url}</p>
                  <h2>{runId}</h2>
                  <p className="muted">
                    {status.phase} · {loaded.manifest.acceptedCount} accepted tasks · commit{" "}
                    {loaded.manifest.repository.commit.slice(0, 12)}
                  </p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void downloadClean()}
                >
                  {removed.size
                    ? `Download cleaned export (${loaded.tasks.length - removed.size})`
                    : "Download export copy"}
                </button>
              </div>
              <div className="review-grid">
                <div className="task-list surface">
                  <div className="section-heading">
                    <h2>Tasks</h2>
                    <span>{removed.size} marked for removal</span>
                  </div>
                  {loaded.tasks.map((task) => (
                    <button
                      type="button"
                      className={`task-row ${task.taskId === selectedTask?.taskId ? "selected" : ""} ${removed.has(task.taskId) ? "removed" : ""}`}
                      key={task.taskId}
                      onClick={() => setSelectedTaskId(task.taskId)}
                    >
                      <strong>{task.taskId}</strong>
                      <span>{removed.has(task.taskId) ? "marked for removal" : "keep"}</span>
                    </button>
                  ))}
                </div>
                {selectedTask && (
                  <React.Suspense
                    fallback={<div className="task-detail surface">Loading task…</div>}
                  >
                    <TaskPanel
                      task={selectedTask}
                      removed={removed.has(selectedTask.taskId)}
                      onToggle={() => toggleRemoved(selectedTask.taskId)}
                    />
                  </React.Suspense>
                )}
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
