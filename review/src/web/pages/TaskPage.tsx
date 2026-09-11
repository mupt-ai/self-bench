import React from "react";
import { Link, useParams } from "react-router";
import { fetchTasks, type TaskItem } from "../api";
import { pageGutter } from "../layout";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { LiveTaskState } from "../task/LiveTaskState";
import { ReviewBar } from "../task/ReviewBar";
import { rowFor, siteTaskSource } from "../task/site-source";
import { TaskSkeleton } from "../task/TaskSkeleton";
import { TaskView } from "../task/TaskView";
import { taskTitle } from "../task/task-title";
import { Breadcrumbs, Notice, PageFrame } from "../ui";

export function TaskPage() {
  const { org } = useOrg();
  const { owner = "", name = "", runId = "", taskId = "" } = useParams();
  const fullName = `${owner}/${name}`;
  const [task, setTask] = React.useState<TaskItem | null | undefined>(undefined);
  const title = taskTitle(task ?? { taskId });
  useDocumentTitle(`${title} · self-bench`);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchTasks(org.login, fullName).then(
      (tasks) => {
        if (cancelled) return;
        setTask(tasks.find((t) => t.runId === runId && t.taskId === taskId) ?? null);
      },
      (cause: Error) => !cancelled && setError(cause.message),
    );
    return () => {
      cancelled = true;
    };
  }, [org.login, fullName, runId, taskId]);

  const source = React.useMemo(
    () => (task ? siteTaskSource(org.login, fullName, task) : null),
    [org.login, fullName, task],
  );

  const onReview = (updated: TaskItem) => setTask(updated);

  if (error) {
    return (
      <PageFrame>
        <Notice>{error}</Notice>
      </PageFrame>
    );
  }
  if (task === undefined) return <TaskSkeleton fullName={fullName} taskId={taskId} />;
  if (task === null || !source) {
    return (
      <PageFrame>
        <Notice>
          Task not found. <Link to={`/repos/${fullName}`}>Back to {fullName}</Link>
        </Notice>
      </PageFrame>
    );
  }
  return (
    <div className="grid h-[calc(100dvh-56px)] min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)]">
      <header
        className={`flex flex-wrap items-start justify-between gap-4 border-b border-border bg-card py-4 ${pageGutter}`}
      >
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: fullName, to: `/repos/${fullName}` },
              {
                label: "Batch",
                to: `/repos/${fullName}/batches/${encodeURIComponent(task.runId)}`,
              },
            ]}
          />
          <h1 className="text-xl leading-7 font-medium wrap-anywhere">
            {task.sourceUrl ? (
              <a
                className="hover:text-brand"
                href={task.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {title}
              </a>
            ) : (
              title
            )}
          </h1>
          <div className="mt-1">
            <LiveTaskState task={task} org={org.login} fullName={fullName} />
          </div>
          {task.pipelineStatus === "infrastructure_failed" &&
          (task.reason || task.reasonSummary) ? (
            <div className="mt-3 font-mono text-sm leading-6 text-muted-foreground">
              <p>{task.reasonSummary}</p>
              {task.reason && (
                <details className="mt-2 [&_summary]:cursor-pointer [&_pre]:mt-2 [&_pre]:max-h-64 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere">
                  <summary>Technical Details</summary>
                  <pre>{task.reason.replace(`${task.reasonSummary}\n\n`, "")}</pre>
                </details>
              )}
            </div>
          ) : task.reasonSummary && task.state !== "accepted" ? (
            <p
              className="mt-2 max-w-[90ch] font-mono text-sm leading-6 text-muted-foreground wrap-anywhere"
              title={task.reasonSummary}
            >
              {task.reasonSummary}
            </p>
          ) : null}
        </div>
        {task.state !== "in_progress" && task.state !== "failed" && (
          <ReviewBar org={org.login} fullName={fullName} task={task} onReview={onReview} />
        )}
      </header>
      <TaskView source={source} row={rowFor(task)} />
    </div>
  );
}
