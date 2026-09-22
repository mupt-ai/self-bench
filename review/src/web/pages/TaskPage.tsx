import React from "react";
import { Link, useParams } from "react-router";
import { fetchTask, type TaskItem } from "../api";
import { pageGutter } from "../layout";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { LiveTaskState } from "../task/LiveTaskState";
import { ReviewBar } from "../task/ReviewBar";
import { rowFor, siteTaskSource } from "../task/site-source";
import { TaskGenerationControls } from "../task/TaskGenerationControls";
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
  useDocumentTitle(`${title} · SelfBench`);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const found = await fetchTask(org.login, fullName, runId, taskId);
      setTask(found);
      setError(null);
      return found;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  }, [org.login, fullName, runId, taskId]);

  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const found = await refresh();
      if (!disposed && (!found || found.state === "in_progress"))
        timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  const source = React.useMemo(
    () => (task ? siteTaskSource(org.login, fullName, task) : null),
    [org.login, fullName, task],
  );
  const technicalDetails = task ? taskTechnicalDetails(task.reason, task.reasonSummary) : undefined;

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
    <div className="grid h-full min-h-0 min-w-0 flex-none grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <header
        className={`flex flex-wrap items-start justify-between gap-4 border-b border-border bg-background py-5 ${pageGutter}`}
      >
        <div className="min-w-0">
          <Breadcrumbs
            items={[
              { label: "Repositories", to: "/" },
              { label: fullName, to: `/repos/${fullName}`, mono: true },
              {
                label: "Batch",
                to: `/repos/${fullName}/batches/${encodeURIComponent(task.runId)}`,
              },
            ]}
          />
          <h1 className="font-mono text-xl leading-7 font-medium wrap-anywhere">
            {task.sourceUrl ? (
              <a
                className="hover:underline hover:underline-offset-4"
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
            <div className="mt-3 text-sm leading-6 text-muted-foreground">
              {task.reasonSummary && <p>{task.reasonSummary}</p>}
              {technicalDetails && (
                <details className="mt-2 [&_summary]:cursor-pointer [&_pre]:mt-2 [&_pre]:max-h-64 [&_pre]:overflow-auto [&_pre]:font-mono [&_pre]:text-xs [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere">
                  <summary>Technical Details</summary>
                  <pre>{technicalDetails}</pre>
                </details>
              )}
            </div>
          ) : task.reasonSummary && task.state !== "accepted" ? (
            <p
              className="mt-2 max-w-[90ch] text-sm leading-6 text-muted-foreground wrap-anywhere"
              title={task.reasonSummary}
            >
              {task.reasonSummary}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <TaskGenerationControls
            task={task}
            org={org.login}
            fullName={fullName}
            onRequested={() => void refresh()}
          />
          {task.state !== "in_progress" &&
            task.state !== "failed" &&
            task.state !== "cancelled" && (
              <ReviewBar org={org.login} fullName={fullName} task={task} onReview={onReview} />
            )}
        </div>
      </header>
      <TaskView source={source} row={rowFor(task)} />
    </div>
  );
}

function taskTechnicalDetails(
  reason: string | undefined,
  summary: string | undefined,
): string | undefined {
  if (!reason) return undefined;
  const normalizedReason = reason.trim();
  if (!summary) return normalizedReason || undefined;

  const normalizedSummary = summary.trim();
  if (normalizedReason === normalizedSummary) return undefined;
  if (normalizedReason.startsWith(normalizedSummary)) {
    const remainder = normalizedReason.slice(normalizedSummary.length).trim();
    return remainder || undefined;
  }
  return normalizedReason || undefined;
}
