import type { BatchStatus } from "../batch-api";
import { cn } from "../primitives/cn";

export const batchPath = (fullName: string, runId?: string) =>
  `/repos/${fullName}/batches${runId ? `/${encodeURIComponent(runId)}` : ""}`;
export const batchName = (runId: string) => `Batch ${runId.replace(/^batch-/, "").slice(0, 8)}`;
export const batchDate = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const labels: Record<BatchStatus["phase"], string> = {
  queued: "Queued",
  discovering: "Discovering",
  authoring: "Generating Tasks",
  exporting: "Exporting",
  complete: "Complete",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
};
export function BatchState({ phase }: { phase?: BatchStatus["phase"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap text-xs before:size-1.5 before:shrink-0 before:bg-current",
        phase === "failed" || phase === "blocked"
          ? "text-destructive"
          : phase === "complete"
            ? "text-success"
            : phase === "cancelled" || !phase
              ? "text-muted-foreground"
              : "text-brand",
      )}
    >
      {phase ? labels[phase] : "Loading Status…"}
    </span>
  );
}
export function batchMessage(status: BatchStatus) {
  if (status.error) return status.error;
  switch (status.phase) {
    case "blocked":
      return "Discovery ended before finding enough candidates. This batch has stopped.";
    case "failed":
      return "This batch stopped before completing.";
    case "cancelled":
      return "This batch was cancelled. Any generated tasks remain in the dataset.";
    case "complete":
      return "Generation is complete. Review the generated tasks in your dataset.";
    case "discovering":
      return "Finding repository changes to turn into tasks.";
    case "authoring":
      return "Authoring and verifying the discovered tasks.";
    case "exporting":
      return "Preparing the generated tasks for export.";
    case "queued":
      return "Waiting for the generation worker.";
  }
}
