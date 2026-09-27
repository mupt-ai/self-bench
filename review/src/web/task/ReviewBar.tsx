import { Check, CircleX } from "lucide-react";
import React from "react";
import { clearReview, formatAgo, putReview, type TaskItem } from "../api";
import { Button, Input } from "../ui";
import { isTyping } from "./review-queue";

/**
 * Approve decides in one click (or `A`); Reject (or `R`) asks for an optional reason first.
 * `onDecided` hears only new decisions, so the page can move on to the next task.
 */
export function ReviewBar({
  org,
  fullName,
  task,
  onReview,
  onDecided,
}: {
  org: string;
  fullName: string;
  task: TaskItem;
  onReview: (updated: TaskItem) => void;
  onDecided?: (updated: TaskItem) => void;
}) {
  const [rejecting, setRejecting] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Two quick presses of `A` land before `busy` re-renders; the ref drops the second.
  const saving = React.useRef(false);
  // A save that finishes after the reviewer moved to another task must not move them again.
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const decide = (decision: "approve" | "reject") => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    putReview(org, fullName, task.runId, task.taskId, {
      decision,
      note: decision === "reject" ? note.trim() : "",
    }).then(
      (updated) => {
        saving.current = false;
        if (!mounted.current) return;
        setBusy(false);
        setRejecting(false);
        setNote("");
        onReview(updated);
        onDecided?.(updated);
      },
      (cause: Error) => {
        saving.current = false;
        setBusy(false);
        setError(cause.message);
      },
    );
  };
  const decided = !!task.review;
  const decideRef = React.useRef(decide);
  decideRef.current = decide;
  React.useEffect(() => {
    if (decided || rejecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      if (event.key === "a") {
        event.preventDefault();
        decideRef.current("approve");
      } else if (event.key === "r") {
        event.preventDefault();
        setRejecting(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decided, rejecting]);

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
      <div className="panel flex min-w-0 max-w-full flex-wrap items-center gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
              task.review.decision === "approve" ? "text-success" : "text-destructive"
            }`}
          >
            {task.review.decision === "approve" ? (
              <Check aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
            ) : (
              <CircleX aria-hidden="true" className="size-3.5" strokeWidth={2} />
            )}
            {task.review.decision === "approve" ? "Approved" : "Rejected"}
          </span>
          <span className="text-xs text-muted-foreground">
            {task.review.decidedBy} · {formatAgo(task.review.decidedAt)}
          </span>
          {task.review.note && (
            <span
              className="max-w-[40ch] truncate text-sm text-foreground"
              title={task.review.note}
            >
              “{task.review.note}”
            </span>
          )}
        </div>
        <Button type="button" variant="ghost" size="small" disabled={busy} onClick={clear}>
          Clear Decision
        </Button>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {rejecting ? (
        <form
          className="flex flex-wrap items-center gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            decide("reject");
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setRejecting(false);
          }}
        >
          <Input
            className="w-64 max-w-full"
            placeholder="Why reject? (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            aria-label="Review Note"
            autoFocus
          />
          <Button type="submit" variant="destructive" disabled={busy}>
            {busy ? "Saving…" : "Confirm Reject"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            title="Reject (R)"
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            title="Approve (A)"
            onClick={() => decide("approve")}
          >
            {busy ? "Saving…" : "Approve"}
          </Button>
        </>
      )}
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  );
}
