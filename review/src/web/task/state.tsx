import type { TaskState } from "../api";

export const STATE_LABEL: Record<TaskState, string> = {
  needs_review: "Needs Review",
  accepted: "Accepted",
  rejected: "Rejected",
  failed: "Failed",
  in_progress: "In Progress",
};

/** A square state marker in the site's palette. */
export function StateStamp({ state, big = false }: { state: TaskState; big?: boolean }) {
  const colors: Record<TaskState, string> = {
    needs_review: "border-warning/50 text-warning",
    accepted: "border-mint/50 text-mint",
    rejected: "border-danger/50 text-danger",
    failed: "border-danger/50 text-danger",
    in_progress: "border-mint/40 text-mint-bright",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 border font-mono text-[10px] font-medium tracking-widest whitespace-nowrap uppercase before:size-1.5 before:bg-current before:content-[''] ${colors[state]} ${big ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5"}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

export function DifficultyStamp({ difficulty }: { difficulty: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-line-strong px-2 py-0.5 font-mono text-[10px] font-medium tracking-widest whitespace-nowrap text-muted uppercase">
      {difficulty}
    </span>
  );
}
