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
  preparing: "Preparing",
  discovering: "Discovering",
  authoring: "Generating Tasks",
  exporting: "Exporting",
  complete: "Complete",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
  cancelling: "Cancelling",
};
export function BatchState({ phase }: { phase?: BatchStatus["phase"] }) {
  const tone =
    phase === "failed" || phase === "blocked"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : phase === "complete"
        ? "border-success/40 bg-success/10 text-success"
        : phase === "cancelled" || !phase
          ? "border-border bg-muted text-muted-foreground"
          : "border-check/40 bg-check/10 text-check";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium",
        tone,
      )}
    >
      {phase ? labels[phase] : "Loading Status…"}
    </span>
  );
}
