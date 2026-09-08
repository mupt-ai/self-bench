import React from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { type ConnectedRepo, fetchConnectedRepos, fetchTasks, type TaskItem } from "../api";
import { GitHubMark, useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { ReviewTaskList } from "../task/ReviewTaskList";
import { type Filter, TaskFilters } from "../task/TaskFilters";
import { TaskListSkeleton } from "../task/TaskListSkeleton";
import { taskKey } from "../task/task-deletion";
import { buttonStyles } from "../ui";

export function RepoPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  return <RepoTasksPage key={`${org.login}/${owner}/${name}`} />;
}

function RepoTasksPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`Dataset · ${fullName} · self-bench`);
  const [repo, setRepo] = React.useState<ConnectedRepo | null | undefined>(undefined);
  const [tasks, setTasks] = React.useState<TaskItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [params] = useSearchParams();
  const [filter, setFilter] = React.useState<Filter>(
    params.get("state") === "in_progress" ? "in_progress" : "accepted",
  );
  const [query, setQuery] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [actionsTarget, setActionsTarget] = React.useState<HTMLDivElement | null>(null);
  const requestVersion = React.useRef(0);

  const loadTasks = React.useCallback(() => {
    const version = ++requestVersion.current;
    setTasks(null);
    fetchTasks(org.login, fullName).then(
      (found) => version === requestVersion.current && setTasks(found),
      (cause: Error) => version === requestVersion.current && setError(cause.message),
    );
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
    loadTasks();
    return () => {
      cancelled = true;
    };
  }, [org.login, fullName, loadTasks]);

  // While anything is being built, re-read the list so stage and round move on their own.
  const building = (tasks ?? []).some((task) => task.state === "in_progress");
  React.useEffect(() => {
    if (!building || deleting) return;
    const timer = window.setInterval(() => {
      const version = requestVersion.current;
      fetchTasks(org.login, fullName).then(
        (found) => version === requestVersion.current && setTasks(found),
        () => undefined,
      );
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [building, deleting, org.login, fullName]);
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
        <p className="mb-4 font-mono text-base text-danger">
          {fullName} is not connected in {org.login}. <Link to="/">Back to Repositories</Link>
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4 [&_h1]:font-sans [&_h1]:text-xl [&_h1]:leading-tight [&_h1]:font-semibold">
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
            <h1 className="m-0">Dataset</h1>
            {repo?.private && (
              <span className="inline-flex items-center border border-warning/30 bg-warning/10 px-2 py-0.5 font-mono text-sm leading-none text-warning">
                Private
              </span>
            )}
          </div>
          <div className="mt-1.5 flex gap-2 text-sm text-muted">
            <span className="font-mono">{fullName}</span>
            {repo && <span className="font-mono">{repo.defaultBranch}</span>}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2.5 sm:w-auto">
          <div ref={setActionsTarget} className="contents" />
          <Link
            className={buttonStyles.primary}
            to={`/repos/${fullName}/add-prs`}
            onClick={(event) => {
              if (deleting) event.preventDefault();
            }}
            aria-disabled={deleting}
          >
            + Add PRs
          </Link>
        </div>
      </div>
      {error && <p className="mb-4 font-mono text-base text-danger">{error}</p>}
      <TaskFilters
        counts={counts}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        disabled={deleting}
      />
      {tasks === null && !error && <TaskListSkeleton />}
      {tasks !== null && tasks.length === 0 && (
        <div className="border border-dashed border-line-strong px-4 py-6 text-center font-mono text-sm leading-6 text-muted">
          <p>No tasks yet. Add a PR to generate a task.</p>
        </div>
      )}
      {tasks !== null && tasks.length > 0 && visible.length === 0 && (
        <div className="border border-dashed border-line-strong px-4 py-6 text-center font-mono text-sm leading-6 text-muted">
          <p>No tasks match.</p>
        </div>
      )}
      <ReviewTaskList
        actionsTarget={actionsTarget}
        org={org.login}
        fullName={fullName}
        visible={visible}
        selectionScope={`${filter}/${query}`}
        onDeleting={(value) => {
          if (value) ++requestVersion.current;
          setDeleting(value);
        }}
        onDeleted={(deleted) =>
          setTasks((current) => current?.filter((task) => !deleted.has(taskKey(task))) ?? null)
        }
      />
    </section>
  );
}
