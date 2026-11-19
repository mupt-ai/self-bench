import { MessageSquareText } from "lucide-react";
import React from "react";
import { Link, useNavigate } from "react-router";
import type { TaskItem } from "../api";
import { buttonStyles } from "../ui";
import { feedbackLink } from "./feedback-link";
import { ReviewBar } from "./ReviewBar";
import { isTyping } from "./review-queue";

/**
 * The task's actions: Give Feedback (or `F`), which opens the Feedback tab with the cursor in it,
 * and, once the task is built, Approve and Reject. Feedback on a finished task revises it; on one
 * still generating, it steers the author.
 */
export function TaskActions({
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
  const navigate = useNavigate();
  const reviewable =
    task.state !== "in_progress" && task.state !== "failed" && task.state !== "cancelled";
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event) || event.key !== "f" || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      void navigate(feedbackLink(""));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Link
        className={buttonStyles.secondary}
        to={feedbackLink("")}
        title={task.state === "in_progress" ? "Steer the author (F)" : "Revise this task (F)"}
      >
        <MessageSquareText className="size-4" aria-hidden="true" />
        Give Feedback
      </Link>
      {reviewable && (
        <ReviewBar
          org={org}
          fullName={fullName}
          task={task}
          onReview={onReview}
          onDecided={onDecided}
        />
      )}
    </div>
  );
}
