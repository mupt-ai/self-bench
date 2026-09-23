import React from "react";
import { cancelTaskGeneration, type TaskItem } from "../api";
import { GenerationCost } from "../GenerationCost";
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
  return (
    <div className="flex flex-wrap items-center justify-end gap-3" aria-live="polite">
      <GenerationCost cost={task.cost} />
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
