import React from "react";
import { Link, useParams } from "react-router";
import {
  clearReview,
  fetchTasks,
  formatAgo,
  putReview,
  type TaskItem,
  type TaskReview,
} from "../api";
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

  const onReview = (review: TaskReview | null) =>
    setTask((current) => {
      if (!current) return current;
      const { review: _dropped, ...rest } = current;
      const pipelineState =
        current.pipelineStatus === "accepted" || current.stage === "accepted"
          ? "needs_review"
          : "rejected";
      return {
        ...rest,
        ...(review ? { review } : {}),
        state: review ? (review.decision === "approve" ? "accepted" : "rejected") : pipelineState,
      };
    });

  if (error) {
    return (
      <main className="site-main">
        <p className="page-error">{error}</p>
      </main>
    );
  }
  if (task === undefined) return <TaskSkeleton fullName={fullName} taskId={taskId} />;
  if (task === null || !source) {
    return (
      <main className="site-main">
        <p className="page-error">
          Task not found. <Link to={`/repos/${fullName}`}>Back to {fullName}</Link>
        </p>
      </main>
    );
  }
  return (
    <div className="task-shell">
      <header className="task-head">
        <div className="task-head-main">
          <nav className="crumbs">
            <Link to="/">Repositories</Link>
            <span aria-hidden="true">/</span>
            <Link to={`/repos/${fullName}`}>{fullName}</Link>
            <span aria-hidden="true">/</span>
            <span>{task.taskId}</span>
          </nav>
          <div className="task-head-row">
            <h1>{task.taskId}</h1>
            <DifficultyStamp difficulty={task.difficulty} />
            <StateStamp state={task.state} big />
            {task.sourcePr && (
              <a className="task-pr" href={task.sourceUrl} target="_blank" rel="noreferrer">
                PR #{task.sourcePr}
              </a>
            )}
            <span className="task-run mono">{task.runId}</span>
          </div>
          {task.reasonSummary && task.state !== "accepted" && (
            <p className="task-reason" title={task.reasonSummary}>
              {task.reasonSummary}
            </p>
          )}
        </div>
        <ReviewBar org={org.login} fullName={fullName} task={task} onReview={onReview} />
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
  onReview: (review: TaskReview | null) => void;
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
      (review) => {
        setBusy(false);
        setPending(null);
        setNote("");
        onReview(review);
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
      () => {
        setBusy(false);
        onReview(null);
      },
      (cause: Error) => {
        setBusy(false);
        setError(cause.message);
      },
    );
  };

  if (task.review) {
    return (
      <div className="review-bar">
        <div className="review-verdict">
          <span className="eyebrow">
            {task.review.decision === "approve" ? "Approved" : "Rejected"}
          </span>
          <span className="review-by">
            by <span className="mono">{task.review.decidedBy}</span>{" "}
            {formatAgo(task.review.decidedAt)}
          </span>
          {task.review.note && <span className="review-note">“{task.review.note}”</span>}
        </div>
        <button type="button" className="btn-ghost" disabled={busy} onClick={clear}>
          Clear Decision
        </button>
        {error && <span className="review-error">{error}</span>}
      </div>
    );
  }
  return (
    <div className="review-bar">
      {pending ? (
        <form
          className="review-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            className="review-input"
            placeholder={pending === "approve" ? "Note (optional)" : "Why reject? (optional)"}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            aria-label="Review note"
          />
          <button
            type="submit"
            className={pending === "approve" ? "btn-primary" : "btn-danger"}
            disabled={busy}
          >
            {busy ? "Saving…" : pending === "approve" ? "Confirm Approve" : "Confirm Reject"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setPending(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button type="button" className="btn-danger" onClick={() => setPending("reject")}>
            Reject
          </button>
          <button type="button" className="btn-primary" onClick={() => setPending("approve")}>
            Approve
          </button>
        </>
      )}
      {error && <span className="review-error">{error}</span>}
    </div>
  );
}
