import React from "react";
import { Link, useParams } from "react-router";
import { clearReview, fetchTasks, formatAgo, putReview, type TaskItem } from "../api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { rowFor, siteTaskSource } from "../task/site-source";
import { DifficultyStamp, StateStamp } from "../task/state";
import { TaskSkeleton } from "../task/TaskSkeleton";
import { TaskView } from "../task/TaskView";

export function TaskPage() {
  const { org } = useOrg();
  const { owner = "", name = "", runId = "", taskId = "" } = useParams();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`${taskId} · self-bench`);
  const [task, setTask] = React.useState<TaskItem | null | undefined>(undefined);
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
      <main className="w-full min-w-0 flex-1 px-4 pt-8 pb-12 sm:px-[var(--site-gutter)]">
        <p className="mb-4 font-mono text-base text-danger">{error}</p>
      </main>
    );
  }
  if (task === undefined) return <TaskSkeleton fullName={fullName} taskId={taskId} />;
  if (task === null || !source) {
    return (
      <main className="w-full min-w-0 flex-1 px-4 pt-8 pb-12 sm:px-[var(--site-gutter)]">
        <p className="mb-4 font-mono text-base text-danger">
          Task not found. <Link to={`/repos/${fullName}`}>Back to {fullName}</Link>
        </p>
      </main>
    );
  }
  return (
    <div className="grid h-[calc(100vh-56px)] min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-line bg-surface px-4 pt-4.5 pb-4 sm:px-[var(--site-gutter)]">
        <div className="min-w-0">
          <nav
            aria-label="Breadcrumb"
            className="mb-3.5 flex flex-wrap gap-2 font-mono text-sm font-medium text-dim [&_a]:text-muted [&_a:hover]:text-mint-bright"
          >
            <Link to="/">Repositories</Link>
            <span aria-hidden="true">/</span>
            <Link to={`/repos/${fullName}`}>{fullName}</Link>
            <span aria-hidden="true">/</span>
            <span>{task.taskId}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 [&_h1]:font-mono [&_h1]:text-lg [&_h1]:leading-tight [&_h1]:font-semibold [&_h1]:wrap-anywhere">
            <h1>{task.taskId}</h1>
            <DifficultyStamp difficulty={task.difficulty} />
            <StateStamp state={task.state} />
            {task.sourcePr && (
              <a
                className="border-b border-line-strong font-mono text-sm font-medium text-muted hover:border-mint hover:text-mint-bright"
                href={task.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                PR #{task.sourcePr}
              </a>
            )}
            <span className="text-sm text-dim font-mono">{task.runId}</span>
          </div>
          {task.pipelineStatus === "infrastructure_failed" &&
          (task.reason || task.reasonSummary) ? (
            <details className="mt-3 font-mono text-sm text-muted [&_summary]:cursor-pointer [&_pre]:mt-2 [&_pre]:max-h-64 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere">
              <summary>Technical Details</summary>
              <pre>{task.reason || task.reasonSummary}</pre>
            </details>
          ) : task.reasonSummary && task.state !== "accepted" ? (
            <p
              className="mt-2 max-w-[90ch] font-mono text-sm leading-6 text-muted wrap-anywhere"
              title={task.reasonSummary}
            >
              {task.reasonSummary}
            </p>
          ) : null}
        </div>
        {task.state === "in_progress" ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2.5 pt-2 sm:pt-5.5">
            <span className="text-sm text-muted">
              {task.stage}
              {task.round ? ` · round ${task.round}` : ""}
            </span>
          </div>
        ) : task.state === "failed" ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2.5 pt-2 sm:pt-5.5">
            <span className="text-sm text-muted">SelfBench Failed · No Verdict</span>
          </div>
        ) : (
          <ReviewBar org={org.login} fullName={fullName} task={task} onReview={onReview} />
        )}
      </header>
      <TaskView source={source} row={rowFor(task)} />
    </div>
  );
}

function ReviewBar({
  org,
  fullName,
  task,
  onReview,
}: {
  org: string;
  fullName: string;
  task: TaskItem;
  onReview: (updated: TaskItem) => void;
}) {
  const [pending, setPending] = React.useState<"approve" | "reject" | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = () => {
    if (!pending) return;
    setBusy(true);
    putReview(org, fullName, task.runId, task.taskId, {
      decision: pending,
      note: note.trim(),
    }).then(
      (updated) => {
        setBusy(false);
        setPending(null);
        setNote("");
        onReview(updated);
      },
      (cause: Error) => {
        setBusy(false);
        setError(cause.message);
      },
    );
  };
  const clear = () => {
    setBusy(true);
    clearReview(org, fullName, task.runId, task.taskId).then(
      (updated) => {
        setBusy(false);
        onReview(updated);
      },
      (cause: Error) => {
        setBusy(false);
        setError(cause.message);
      },
    );
  };

  if (task.review) {
    return (
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2.5 pt-2 sm:pt-5.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm font-medium tracking-[0.14em] text-mint uppercase">
            {task.review.decision === "approve" ? "Approved" : "Rejected"}
          </span>
          <span className="text-sm text-muted">
            by <span className="font-mono">{task.review.decidedBy}</span>{" "}
            {formatAgo(task.review.decidedAt)}
          </span>
          {task.review.note && (
            <span className="max-w-[40ch] truncate text-sm text-ink">“{task.review.note}”</span>
          )}
        </div>
        <button
          type="button"
          className="inline-flex min-h-9 items-center justify-center gap-2 px-3 font-sans text-sm text-muted hover:text-mint-bright disabled:opacity-40"
          disabled={busy}
          onClick={clear}
        >
          Clear Decision
        </button>
        {error && <span className="font-mono text-sm text-danger">{error}</span>}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2.5 pt-2 sm:pt-5.5">
      {pending ? (
        <form
          className="flex flex-wrap items-center gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            className="h-9 w-[320px] max-w-full border border-line-strong bg-bg px-3 font-sans text-base text-ink placeholder:text-dim focus:border-mint"
            placeholder={pending === "approve" ? "Note (Optional)" : "Why reject? (optional)"}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            aria-label="Review Note"
          />
          <button
            type="submit"
            className={
              pending === "approve"
                ? "inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-mint bg-mint px-4 font-sans text-sm font-bold text-bg hover:bg-mint-bright disabled:cursor-not-allowed disabled:opacity-40"
                : "inline-flex h-9 items-center justify-center border border-danger/55 px-4 font-sans text-sm font-bold text-danger hover:border-danger hover:bg-danger/10 disabled:opacity-50"
            }
            disabled={busy}
          >
            {busy ? "Saving…" : pending === "approve" ? "Confirm Approve" : "Confirm Reject"}
          </button>
          <button
            type="button"
            className="inline-flex min-h-9 items-center justify-center gap-2 px-3 font-sans text-sm text-muted hover:text-mint-bright disabled:opacity-40"
            onClick={() => setPending(null)}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center border border-danger/55 px-4 font-sans text-sm font-bold text-danger hover:border-danger hover:bg-danger/10 disabled:opacity-50"
            onClick={() => setPending("reject")}
          >
            Reject
          </button>
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-mint bg-mint px-4 font-sans text-sm font-bold text-bg hover:bg-mint-bright disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setPending("approve")}
          >
            Approve
          </button>
        </>
      )}
      {error && <span className="font-mono text-sm text-danger">{error}</span>}
    </div>
  );
}
