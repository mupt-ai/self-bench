import React from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { isEvalName } from "../../../../src/contracts/evals";
import { fetchTask, type TaskItem } from "../api";
import { pageGutter } from "../layout";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { FeedbackSheet } from "../task/FeedbackSheet";
import { LiveTaskState } from "../task/LiveTaskState";
import { QueueNav } from "../task/QueueNav";
import { ReviewBar } from "../task/ReviewBar";
import { queuePosition, readQueue, type TaskRef, taskPath } from "../task/review-queue";
import { prefetchTaskFiles, rowFor, siteTaskSource } from "../task/site-source";
import { TaskCost, TaskGenerationControls } from "../task/TaskGenerationControls";
import { TaskSkeleton } from "../task/TaskSkeleton";
import { TaskView } from "../task/TaskView";
import { taskTitle } from "../task/task-title";
import { listTaskVariants, type VariantItem } from "../task/task-variant-api";
import { taskTechnicalDetails } from "../task/technical-details";
import { CreateVariantButton } from "../task/VariantDialog";
import { VariantsPanel } from "../task/VariantsPanel";
import { Breadcrumbs, Notice, PageFrame } from "../ui";

/** Keyed by the route, so a new task never inherits the previous task's state or controls. */
export function TaskPage() {
  const { org } = useOrg();
  const { owner = "", name = "", runId = "", taskId = "" } = useParams();
  return <TaskPageContent key={JSON.stringify([org.login, owner, name, runId, taskId])} />;
}

function TaskPageContent() {
  const { org } = useOrg();
  const { owner = "", name = "", runId = "", taskId = "" } = useParams();
  const fullName = `${owner}/${name}`;
  const [task, setTask] = React.useState<TaskItem | null | undefined>(undefined);
  const [revisions, setRevisions] = React.useState<TaskItem[]>([]);
  const [variants, setVariants] = React.useState<VariantItem[]>([]);
  // Sending feedback starts a revision, which the page then follows until it finishes.
  const [followed, setFollowed] = React.useState(0);
  const follow = () => setFollowed((count) => count + 1);
  const title = taskTitle(task ?? { taskId });
  useDocumentTitle(`${title} · SelfBench`);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [found, listed] = await Promise.all([
        fetchTask(org.login, fullName, runId, taskId),
        listTaskVariants(org.login, fullName, { runId, taskId }).catch(() => undefined),
      ]);
      setTask(found.task);
      setRevisions(found.revisions);
      if (listed) setVariants(listed);
      setError(null);
      return { ...found, variants: listed ?? [] };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  }, [org.login, fullName, runId, taskId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a sent revision restarts the polling.
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const found = await refresh();
      const active =
        !found ||
        found.task.state === "in_progress" ||
        found.revisions.some((revision) => revision.state === "in_progress") ||
        found.variants.some((variant) => variant.state === "in_progress");
      if (!disposed && active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [refresh, followed]);

  const source = React.useMemo(
    () => (task ? siteTaskSource(org.login, fullName, task) : null),
    [org.login, fullName, task],
  );
  const technicalDetails = task ? taskTechnicalDetails(task.reason, task.reasonSummary) : undefined;

  const onReview = (updated: TaskItem) => setTask(updated);
  const location = useLocation();
  const queue = readQueue(location.state);
  const position = queue ? queuePosition(queue, { runId, taskId }) : undefined;
  const navigate = useNavigate();
  // Replacing keeps the browser's Back button one step from the list, however many tasks were seen.
  const goTo = React.useCallback(
    (target: TaskRef) => {
      if (queue) void navigate(taskPath(fullName, target), { state: { queue }, replace: true });
    },
    [navigate, fullName, queue],
  );
  const onDecided = () => {
    if (position?.next) goTo(position.next);
    else if (queue) void navigate(queue.back, { replace: true });
  };

  const next = position?.next;
  const loaded = task !== undefined;
  React.useEffect(() => {
    if (loaded && next) void prefetchTaskFiles(org.login, fullName, next).catch(() => undefined);
  }, [loaded, next, org.login, fullName]);

  if (error && task === undefined) {
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
              isEvalName(fullName)
                ? { label: "Scenarios", to: "/evals" }
                : { label: "Mined Repos", to: "/" },
              {
                label: fullName,
                to: queue?.backLabel === "Dataset" ? queue.back : `/repos/${fullName}`,
                mono: true,
              },
              {
                label: "Batch",
                to: `/repos/${fullName}/batches/${encodeURIComponent(task.runId)}`,
              },
            ]}
          />
          <h1
            className={`${task.title ? "" : "font-mono "}text-xl leading-7 font-medium wrap-anywhere`}
          >
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
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <LiveTaskState task={task} org={org.login} fullName={fullName} />
            <TaskCost task={task} />
          </div>
          {error && (
            <Notice tone="info" className="mt-3">
              Task status could not be refreshed. Showing the last update. {error}
            </Notice>
          )}
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
          {queue && position && <QueueNav queue={queue} position={position} onGo={goTo} />}
          <TaskGenerationControls
            task={task}
            org={org.login}
            fullName={fullName}
            onRequested={() => void refresh()}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <CreateVariantButton
              task={task}
              org={org.login}
              fullName={fullName}
              onCreated={follow}
            />
            {task.state !== "in_progress" &&
              task.state !== "failed" &&
              task.state !== "cancelled" && (
                <ReviewBar
                  org={org.login}
                  fullName={fullName}
                  task={task}
                  onReview={onReview}
                  onDecided={onDecided}
                />
              )}
          </div>
        </div>
      </header>
      <TaskView
        source={source}
        row={rowFor(task)}
        feedback={
          <FeedbackSheet
            org={org.login}
            fullName={fullName}
            task={task}
            revisions={revisions}
            onSent={follow}
          />
        }
        variants={{
          count: variants.length,
          sheet: (
            <VariantsPanel {...{ org: org.login, fullName, task, variants }} onChanged={follow} />
          ),
        }}
      />
    </div>
  );
}
