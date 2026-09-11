import type { TaskState } from "../api";

export const STATE_LABEL: Record<TaskState, string> = {
  needs_review: "Needs Review",
  accepted: "Accepted",
  rejected: "Rejected",
  failed: "Failed",
  in_progress: "In Progress",
};

/** Readable status text with a small marker, shared by task lists and review. */
export function StateStamp({ state }: { state: TaskState }) {
  const colors: Record<TaskState, string> = {
    needs_review: "text-brand",
    accepted: "text-success",
    rejected: "text-muted-foreground",
    failed: "text-destructive",
    in_progress: "text-brand",
  };
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap text-xs leading-5 before:size-1.5 before:shrink-0 before:bg-current before:content-[''] ${colors[state]}`}
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
