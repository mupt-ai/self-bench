import React from "react";
import { Link, useParams } from "react-router";
import { AddPrSheet } from "../AddPrSheet";
import { AttachRunSheet } from "../AttachRunSheet";
import {
  type AttachedRun,
  type ConnectedRepo,
  detachRun,
  fetchAttachedRuns,
  fetchConnectedRepos,
  fetchTasks,
  formatAgo,
  syncRepo,
  type TaskItem,
  type TaskState,
} from "../api";
import { GitHubMark, useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { STATE_LABEL } from "../task/state";
import { TaskList } from "../task/TaskList";

type Filter = "all" | TaskState;
const FILTERS: Filter[] = ["all", "in_progress", "needs_review", "accepted", "rejected", "failed"];

export function RepoPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`${fullName} · self-bench`);
  const [repo, setRepo] = React.useState<ConnectedRepo | null | undefined>(undefined);
  const [runs, setRuns] = React.useState<AttachedRun[]>([]);
  const [tasks, setTasks] = React.useState<TaskItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [attaching, setAttaching] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const loadTasks = React.useCallback(() => {
    setTasks(null);
    fetchTasks(org.login, fullName).then(setTasks, (cause: Error) => setError(cause.message));
  }, [org.login, fullName]);

  React.useEffect(() => {
    let cancelled = false;
    fetchConnectedRepos(org.login).then(
      (repos) => {
        if (cancelled) return;
        const found = repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
        setRepo(found ?? null);
      },
      (cause: Error) => !cancelled && setError(cause.message),
    );
    fetchAttachedRuns(org.login, fullName).then(
      (found) => !cancelled && setRuns(found),
      () => undefined,
    );
    loadTasks();
    return () => {
      cancelled = true;
    };
  }, [org.login, fullName, loadTasks]);

  const closeSheet = React.useCallback(() => setAttaching(false), []);
  const closeAdd = React.useCallback(() => setAdding(false), []);
  const onStarted = React.useCallback((task: TaskItem) => {
    setTasks((current) => [task, ...(current ?? [])]);
    setAdding(false);
  }, []);

  // While anything is being built, re-read the list so stage and round move on their own.
  const building = (tasks ?? []).some((task) => task.state === "in_progress");
  React.useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(() => {
      fetchTasks(org.login, fullName).then(setTasks, () => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [building, org.login, fullName]);
  const onAttached = React.useCallback(
    (run: AttachedRun) => {
      setRuns((current) => [run, ...current.filter((r) => r.runId !== run.runId)]);
      setAttaching(false);
      loadTasks();
    },
    [loadTasks],
  );
  const refresh = () => {
    setSyncing(true);
    syncRepo(org.login, fullName).then(
      () => {
        setSyncing(false);
        loadTasks();
      },
      (cause: Error) => {
        setSyncing(false);
        setError(cause.message);
      },
    );
  };
  const detach = (run: AttachedRun) => {
    if (!window.confirm(`Detach ${run.runId}? Its tasks leave this repository.`)) return;
    detachRun(org.login, fullName, run.runId).then(
      () => {
        setRuns((current) => current.filter((r) => r.runId !== run.runId));
        loadTasks();
      },
      (cause: Error) => setError(cause.message),
    );
  };

  const counts = React.useMemo(() => {
    const result: Record<Filter, number> = {
      all: 0,
      needs_review: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      in_progress: 0,
    };
    for (const task of tasks ?? []) {
      result.all += 1;
      result[task.state] += 1;
    }
    return result;
  }, [tasks]);
  const needle = query.trim().toLowerCase();
  const visible = (tasks ?? []).filter(
    (task) =>
      (filter === "all" || task.state === filter) &&
      (!needle ||
        task.taskId.toLowerCase().includes(needle) ||
        String(task.sourcePr ?? "").includes(needle) ||
        task.runId.includes(needle)),
  );

  if (repo === null) {
    return (
      <main className="site-main">
        <p className="page-error">
          {fullName} is not connected in {org.login}. <Link to="/">Back to repositories</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="site-main">
      <nav className="crumbs">
        <Link to="/">Repositories</Link>
        <span aria-hidden="true">/</span>
        <span>{fullName}</span>
      </nav>
      <div className="page-head">
        <div>
          <div className="repo-title">
            <a
              className="repo-card-github"
              href={`https://github.com/${fullName}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`${fullName} on GitHub`}
            >
              <GitHubMark />
            </a>
            <h1>{fullName}</h1>
            {repo?.private && <span className="repo-badge">private</span>}
          </div>
          <div className="repo-card-sub">
            {repo && <span className="mono">{repo.defaultBranch}</span>}
            <span className="repo-detail-sep" aria-hidden="true">
              ·
            </span>
            <span>
              {runs.length} attached run{runs.length === 1 ? "" : "s"}
            </span>
            {tasks?.[0] && (
              <>
                <span className="repo-detail-sep" aria-hidden="true">
                  ·
                </span>
                <span>synced {formatAgo(tasks[0].syncedAt)}</span>
              </>
            )}
          </div>
        </div>
        <div className="page-actions">
          {runs.length > 0 && (
            <button type="button" className="btn-ghost" disabled={syncing} onClick={refresh}>
              {syncing ? "Refreshing…" : "Refresh"}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => setAttaching(true)}>
            + Attach Run
          </button>
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            + Add PR
          </button>
        </div>
      </div>
      {error && <p className="page-error">{error}</p>}
      {runs.length > 0 && (
        <div className="run-chips">
          {runs.map((run) => (
            <span className="run-chip" key={run.runId}>
              <span className="mono">{run.runId}</span>
              <button
                type="button"
                className="run-chip-x"
                onClick={() => detach(run)}
                aria-label={`Detach ${run.runId}`}
                title="Detach"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="task-toolbar">
        <div className="filter-chips" role="tablist" aria-label="Task state">
          {FILTERS.map((key) => (
            <button
              type="button"
              key={key}
              role="tab"
              aria-selected={filter === key}
              className="filter-chip"
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "All" : STATE_LABEL[key]}
              <b>{counts[key]}</b>
            </button>
          ))}
        </div>
        <input
          className="task-search"
          type="search"
          placeholder="Search task, PR, or run"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search tasks"
        />
      </div>
      {tasks === null && !error && <TaskListSkeleton />}
      {tasks !== null && tasks.length === 0 && (
        <div className="empty-state">
          <p>No tasks yet. Attach a pipeline run to see its candidates here.</p>
        </div>
      )}
      {tasks !== null && tasks.length > 0 && visible.length === 0 && (
        <p className="repo-note">No tasks match.</p>
      )}
      {visible.length > 0 && <TaskList fullName={fullName} tasks={visible} />}
      {adding && (
        <AddPrSheet org={org} fullName={fullName} onClose={closeAdd} onStarted={onStarted} />
      )}
      {attaching && (
        <AttachRunSheet
          org={org}
          fullName={fullName}
          attached={new Set(runs.map((run) => run.runId))}
          onClose={closeSheet}
          onAttached={onAttached}
        />
      )}
    </main>
  );
}

/** Placeholder rows while the artifact store is listed; same shape as real rows so nothing jumps. */
function TaskListSkeleton() {
  return (
    <ul className="task-list skeleton" aria-busy="true" aria-label="Loading tasks">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li key={index}>
          <div className="task-row">
            <span className="task-row-main">
              <span className="skeleton-bar" style={{ width: `${220 + (index % 3) * 60}px` }} />
              <span
                className="skeleton-bar thin"
                style={{ width: `${380 + (index % 2) * 120}px` }}
              />
            </span>
            <span className="task-row-side">
              <span className="skeleton-bar stamp" />
              <span className="skeleton-bar stamp wide" />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
