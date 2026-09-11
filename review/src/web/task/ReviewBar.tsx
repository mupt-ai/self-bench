import React from "react";
import { clearReview, formatAgo, putReview, type TaskItem } from "../api";
import { Button, Input } from "../ui";

export function ReviewBar({
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
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={
              task.review.decision === "approve"
                ? "text-xs text-success uppercase"
                : "text-xs text-destructive uppercase"
            }
          >
            {task.review.decision === "approve" ? "Approved" : "Rejected"}
          </span>
          <span className="text-sm text-muted-foreground">
            by <span className="font-mono">{task.review.decidedBy}</span>{" "}
            {formatAgo(task.review.decidedAt)}
          </span>
          {task.review.note && (
            <span className="max-w-[40ch] truncate text-sm text-foreground">
              “{task.review.note}”
            </span>
          )}
        </div>
        <Button type="button" variant="ghost" disabled={busy} onClick={clear}>
          Clear Decision
        </Button>
        {error && <span className="font-mono text-sm text-destructive">{error}</span>}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {pending ? (
        <form
          className="flex flex-wrap items-center gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            className="w-64 max-w-full"
            placeholder={pending === "approve" ? "Note (Optional)" : "Why reject? (optional)"}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            aria-label="Review Note"
          />
          <Button
            type="submit"
            variant={pending === "approve" ? "primary" : "destructive"}
            disabled={busy}
          >
            {busy ? "Saving…" : pending === "approve" ? "Confirm Approve" : "Confirm Reject"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <Button type="button" variant="destructive" onClick={() => setPending("reject")}>
            Reject
          </Button>
          <Button type="button" variant="primary" onClick={() => setPending("approve")}>
            Approve
          </Button>
        </>
      )}
      {error && <span className="font-mono text-sm text-destructive">{error}</span>}
    </div>
  );
}
