import { type BatchStatus, batchIsTerminal } from "./batch-api";
import { activityCounts } from "./batches/task-activity";
import { cn } from "./primitives/cn";

/** Progress belongs on the batch page; creation only collects the next batch's settings. */
export function BatchProgress({ status }: { status: BatchStatus }) {
  const counts = activityCounts(status);
  const terminal = batchIsTerminal(status.phase);
  const metrics = [
    ["Verified", status.accepted, "text-success"],
    ...(terminal
      ? [["Stopped", status.tasks ? counts.stopped : undefined, ""]]
      : [
          ["Running", status.tasks ? counts.running : undefined, "text-brand"],
          ["Queued", status.tasks ? counts.queued : undefined, ""],
        ]),
    ["Rejected", status.rejected, ""],
    ["Failed", status.tasks ? counts.infrastructure_failed : undefined, "text-destructive"],
  ] as const;
  return (
    <section className="border border-border bg-card" aria-label="Batch Progress">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Batch Progress</h2>
        <span className="text-xs text-muted-foreground">
          {status.discovered ?? "—"} Candidates Discovered
        </span>
      </div>
      <dl className={cn("grid", terminal ? "grid-cols-4" : "grid-cols-5")}>
        {metrics.map(([label, count, color]) => (
          <div
            key={label}
            className="border-r border-border px-2 py-3 last:border-r-0 sm:px-4 sm:py-4"
          >
            <dt className="text-[10px] text-muted-foreground sm:text-xs">{label}</dt>
            <dd
              className={cn(
                "mt-2 text-2xl leading-none font-medium tabular-nums",
                count ? color : "text-muted-foreground",
              )}
            >
              {count ?? "—"}
            </dd>
          </div>
        ))}
      </dl>{" "}
    </section>
  );
}
