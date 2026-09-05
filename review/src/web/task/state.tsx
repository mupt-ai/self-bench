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
  return <span className={`state-stamp ${state} ${big ? "big" : ""}`}>{STATE_LABEL[state]}</span>;
}

export function DifficultyStamp({ difficulty }: { difficulty: string }) {
  return <span className="difficulty-stamp">{difficulty}</span>;
}
