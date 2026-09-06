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
import { TaskListSkeleton } from "../task/TaskListSkeleton";
import { Button } from "../ui";

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
      <section>
        <p className="mb-4 font-mono text-xs text-danger">
          {fullName} is not connected in {org.login}. <Link to="/">Back to repositories</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-6 [&_h1]:mt-1.5 [&_h1]:font-sans [&_h1]:text-xl [&_h1]:leading-tight [&_h1]:font-semibold">
        <div>
          <div className="flex min-w-0 items-center gap-2.5 [&_h1]:font-mono [&_h1]:text-xl [&_h1]:leading-tight [&_h1]:font-semibold [&_h1]:tracking-tight">
            <a
              className="inline-flex shrink-0 text-muted hover:text-mint-bright [&_svg]:size-4 [&_svg]:fill-current"
              href={`https://github.com/${fullName}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`${fullName} on GitHub`}
            >
              <GitHubMark />
            </a>
            <h1>{fullName}</h1>
            {repo?.private && (
              <span className="text-[10px] tracking-widest text-warning uppercase">private</span>
            )}
          </div>
          <div className="mt-1.5 flex gap-2 text-xs text-muted">
            {repo && <span className="font-mono">{repo.defaultBranch}</span>}
            <span className="text-line-strong" aria-hidden="true">
              ·
            </span>
            <span>
              {runs.length} attached run{runs.length === 1 ? "" : "s"}
            </span>
            {tasks?.[0] && (
              <>
                <span className="text-line-strong" aria-hidden="true">
                  ·
                </span>
                <span>synced {formatAgo(tasks[0].syncedAt)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {runs.length > 0 && (
            <Button type="button" variant="ghost" disabled={syncing} onClick={refresh}>
              {syncing ? "Refreshing…" : "Refresh"}
            </Button>
          )}
          <Button type="button" onClick={() => setAttaching(true)}>
            + Attach Run
          </Button>
          <Button type="button" variant="primary" onClick={() => setAdding(true)}>
            + Add PR
          </Button>
        </div>
      </div>
      {error && <p className="mb-4 font-mono text-xs text-danger">{error}</p>}
      {runs.length > 0 && (
        <div className="-mt-2 mb-5 flex flex-wrap gap-2">
          {runs.map((run) => (
            <span
              className="inline-flex items-center gap-2 border border-line bg-surface py-1 pr-1.5 pl-2.5 text-xs text-muted"
              key={run.runId}
            >
              <span className="font-mono">{run.runId}</span>
              <button
                type="button"
                className="px-1 font-mono text-sm leading-none text-dim hover:text-danger"
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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
        <div
          className="flex max-w-full gap-1.5 overflow-x-auto"
          role="tablist"
          aria-label="Task state"
        >
          {FILTERS.map((key) => (
            <button
              type="button"
              key={key}
              role="tab"
              aria-selected={filter === key}
              className="inline-flex h-8 shrink-0 items-center gap-2 border border-line px-3 font-mono text-xs font-medium text-muted hover:border-line-strong hover:text-ink aria-selected:border-mint aria-selected:bg-surface-2 aria-selected:text-mint [&_b]:font-medium [&_b]:text-dim [&[aria-selected=true]_b]:text-mint-bright"
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "All" : STATE_LABEL[key]}
              <b>{counts[key]}</b>
            </button>
          ))}
        </div>
        <input
          className="h-8 w-[260px] max-w-full border border-line-strong bg-bg px-2.5 font-mono text-xs text-ink placeholder:text-dim focus:border-mint"
          type="search"
          placeholder="Search task, PR, or run"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search tasks"
        />
      </div>
      {tasks === null && !error && <TaskListSkeleton />}
      {tasks !== null && tasks.length === 0 && (
        <div className="border border-dashed border-line-strong px-6 py-12 text-center text-muted">
          <p>No tasks yet. Attach a pipeline run to see its candidates here.</p>
        </div>
      )}
      {tasks !== null && tasks.length > 0 && visible.length === 0 && (
        <p className="py-4 text-muted">No tasks match.</p>
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
    </section>
  );
}
