import { GitBranch, LockKeyhole, Plus } from "lucide-react";
import React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { type ConnectedRepo, fetchConnectedRepos, fetchTasks, type TaskItem } from "../api";
import { BatchActivity } from "../batches/BatchActivity";
import { useBatches } from "../batches/BatchProvider";
import { batchPath } from "../batches/presentation";
import { GenerateBatch } from "../GenerateBatch";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { ReviewTaskList } from "../task/ReviewTaskList";
import { type Filter, TaskFilters } from "../task/TaskFilters";
import { TaskListSkeleton } from "../task/TaskListSkeleton";
import { taskKey } from "../task/task-deletion";
import { Button, buttonStyles, EmptyState, Notice, PageContent, PageHeader } from "../ui";

export function RepoPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  return <RepoTasksPage key={`${org.login}/${owner}/${name}`} />;
}

function RepoTasksPage() {
  const navigate = useNavigate();
  const batches = useBatches();
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
    setError(null);
    setTasks(null);
    fetchTasks(org.login, fullName).then(
      (found) => version === requestVersion.current && setTasks(found),
      (cause: Error) => version === requestVersion.current && setError(cause.message),
    );
  }, [org.login, fullName]);
  const refreshTasks = React.useCallback(() => {
    if (deleting) return;
    const version = ++requestVersion.current;
    fetchTasks(org.login, fullName).then(
      (found) => version === requestVersion.current && setTasks(found),
      (cause: Error) => version === requestVersion.current && setError(cause.message),
    );
  }, [org.login, fullName, deleting]);

  React.useEffect(() => {
    if (batches.revision > 0) refreshTasks();
  }, [batches.revision, refreshTasks]);

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
        task.runId.toLowerCase().includes(needle)),
  );

  if (repo === null) {
    return (
      <PageContent>
        <p className="mb-4 font-mono text-base text-destructive">
          {fullName} is not connected in {org.login}. <Link to="/">Back to Repositories</Link>
        </p>
      </PageContent>
    );
  }

  return (
    <PageContent>
      <PageHeader
        title="Dataset"
        className="max-sm:flex-col max-sm:items-start"
        description={
          repo && (
            <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3.5" aria-hidden="true" />
                {repo.defaultBranch}
              </span>
              {repo.private && (
                <span className="inline-flex items-center gap-1.5">
                  <LockKeyhole className="size-3.5" aria-hidden="true" />
                  Private
                </span>
              )}
            </span>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <GenerateBatch
            repoId={{ org: org.login, fullName }}
            onStarted={(runId, warning) => {
              batches.refresh();
              void navigate(batchPath(fullName, runId), { state: { batchStartWarning: warning } });
            }}
            disabled={deleting}
          />
          <Link
            className={buttonStyles.primary}
            to={`/repos/${fullName}/add-prs`}
            onClick={(event) => {
              if (deleting) event.preventDefault();
            }}
            aria-disabled={deleting}
          >
            <Plus aria-hidden="true" />
            Add PRs
          </Link>
        </div>
      </PageHeader>
      <BatchActivity />
      {error && tasks !== null && <Notice className="mb-4">{error}</Notice>}
      <section className="overflow-clip border border-border bg-card" aria-label="Dataset">
        <TaskFilters
          counts={tasks === null ? null : counts}
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          disabled={deleting || tasks === null}
          actions={
            <div
              ref={setActionsTarget}
              className="flex items-center gap-2 border-t border-border px-4 py-3 empty:hidden"
            />
          }
        />
        {tasks === null && !error && <TaskListSkeleton />}
        {tasks === null && error && (
          <div role="alert">
            <EmptyState
              title="Could Not Load Tasks"
              className="min-h-64 border-0 bg-transparent"
              action={<Button onClick={loadTasks}>Try Again</Button>}
            >
              {error}
            </EmptyState>
          </div>
        )}
        {tasks !== null && tasks.length === 0 && (
          <EmptyState title="No Tasks Yet" className="min-h-64 border-0 bg-transparent">
            Add a PR to generate your first task.
          </EmptyState>
        )}
        {tasks !== null && tasks.length > 0 && visible.length === 0 && (
          <EmptyState
            title="No Matching Tasks"
            className="min-h-64 border-0 bg-transparent"
            action={
              <Button
                variant="ghost"
                disabled={deleting}
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                Clear Filters
              </Button>
            }
          >
            Try a different search or task state.
          </EmptyState>
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
        {tasks !== null && tasks.length > 0 && (
          <p
            className="border-t border-border px-4 py-3 text-xs tabular-nums text-muted-foreground"
            role="status"
          >
            {visible.length === tasks.length
              ? `${tasks.length} Tasks`
              : `${visible.length} of ${tasks.length} Tasks`}
          </p>
        )}
      </section>
    </PageContent>
  );
}
