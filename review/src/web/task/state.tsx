import type { TaskState } from "../api";

export const STATE_LABEL: Record<TaskState, string> = {
  needs_review: "Needs Review",
  accepted: "Accepted",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
  in_progress: "In Progress",
};

/** Readable status text with a small dot after it, shared by task lists and review. */
export function StateStamp({ state }: { state: TaskState }) {
  const colors: Record<TaskState, string> = {
    needs_review: "text-brand-foreground",
    accepted: "text-success",
    rejected: "text-muted-foreground",
    failed: "text-destructive",
    cancelled: "text-muted-foreground",
    in_progress: "text-brand-foreground",
  };
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap text-xs leading-5 font-medium after:ml-2 after:size-1.5 after:shrink-0 after:rounded-full after:bg-current after:content-[''] ${colors[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

export function DifficultyStamp({ difficulty }: { difficulty: string }) {
  const labels: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };
  return (
    <span className="whitespace-nowrap text-xs leading-5 text-muted-foreground">
      {labels[difficulty] ?? difficulty}
    </span>
  );
}
