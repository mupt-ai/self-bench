import { ChevronLeft, ChevronRight } from "lucide-react";
import React from "react";
import { Link } from "react-router";
import { Button } from "../ui";
import { isTyping, type queuePosition, type ReviewQueue, type TaskRef } from "./review-queue";

/** Previous / next through the list the task was opened from, also on `K` / `J`. */
export function QueueNav({
  queue,
  position,
  onGo,
}: {
  queue: ReviewQueue;
  position: NonNullable<ReturnType<typeof queuePosition>>;
  onGo: (task: TaskRef) => void;
}) {
  const { previous, next } = position;
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      const target = event.key === "j" ? next : event.key === "k" ? previous : undefined;
      if (!target) return;
      event.preventDefault();
      onGo(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previous, next, onGo]);
  return (
    <nav className="flex items-center gap-1" aria-label="Task Queue">
      <Link className="mr-2 text-xs text-muted-foreground hover:text-foreground" to={queue.back}>
        Back to {queue.backLabel}
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Previous Task"
        title="Previous Task (K)"
        disabled={!previous}
        onClick={() => previous && onGo(previous)}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="font-mono text-xs tabular-nums text-muted-foreground" role="status">
        {position.index + 1} of {queue.tasks.length}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Next Task"
        title="Next Task (J)"
        disabled={!next}
        onClick={() => next && onGo(next)}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
