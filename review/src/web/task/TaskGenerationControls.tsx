import React from "react";
import { cancelTaskGeneration, type TaskItem } from "../api";
import { costLabel } from "../GenerationCost";
import { Button } from "../ui";

export function TaskGenerationControls({
  task,
  org,
  fullName,
  onRequested,
}: {
  task: TaskItem;
  org: string;
  fullName: string;
  onRequested(): void;
}) {
  const [state, setState] = React.useState<"idle" | "pending" | "requested" | "error">("idle");
  const [error, setError] = React.useState<string>();
  const active = task.state === "in_progress";
  const cancelled = task.state === "cancelled";
  const visibleState = active || cancelled ? state : "idle";
  // Only a running or cancelled generation has anything to control.
  if (!active && !cancelled) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-3" aria-live="polite">
      {(active || cancelled) && (
        <Button
          disabled={!active || visibleState === "pending" || visibleState === "requested"}
          onClick={async () => {
            setState("pending");
            setError(undefined);
            try {
              const result = await cancelTaskGeneration(
                org,
                fullName,
                task.runId,
                task.candidateId,
              );
              setState(result.state === "requested" ? "requested" : "idle");
              onRequested();
            } catch (cause) {
              setState("error");
              setError(cause instanceof Error ? cause.message : "Cancellation failed.");
            }
          }}
        >
          {cancelled
            ? "Cancellation Confirmed"
            : visibleState === "pending"
              ? "Cancelling…"
              : visibleState === "requested"
                ? "Cancellation Requested…"
                : visibleState === "error"
                  ? "Retry Cancellation"
                  : "Cancel Generation"}
        </Button>
      )}
      {error && active && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** A task's generation cost beside its state; a dash until a cost is known. */
export function TaskCost({ task }: { task: TaskItem }) {
  const value = costLabel(task.cost);
  return (
    <span className="text-xs text-muted-foreground">
      Cost <span className="tabular-nums text-foreground">{value === "Unknown" ? "—" : value}</span>
    </span>
  );
}
