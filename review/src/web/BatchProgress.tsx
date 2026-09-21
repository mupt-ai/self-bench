import { ChevronDown } from "lucide-react";
import { type BatchStatus, batchIsTerminal } from "./batch-api";
import { batchMessage } from "./batches/presentation";
import { activityCounts } from "./batches/task-activity";
import { cn } from "./primitives/cn";

/** Progress belongs on the batch page; creation only collects the next batch's settings. */
export function BatchProgress({ status }: { status: BatchStatus }) {
  const discovery = status.discovery;
  const counts = activityCounts(status);
  const terminal = batchIsTerminal(status.phase);
  const stopped = status.phase === "blocked" || status.phase === "failed";
  const finishedDiscovery = discovery
    ? Math.min(discovery.totalShards, discovery.completedShards + discovery.failedShards)
    : 0;
  const accepted = status.accepted ?? 0;
  const requested = status.requested ?? 0;
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
      </dl>
      <div className="border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            {status.accepted ?? "—"} of {status.requested ?? "—"} requested tasks verified
          </span>
          {status.requestedByDifficulty && (
            <span className="text-muted-foreground">
              Target: {status.requestedByDifficulty.easy} easy ·{" "}
              {status.requestedByDifficulty.medium} medium · {status.requestedByDifficulty.hard}{" "}
              hard
            </span>
          )}
        </div>
        {requested > 0 && status.accepted !== undefined && (
          <div
            role="progressbar"
            aria-label="Verified Task Target"
            aria-valuemin={0}
            aria-valuemax={requested}
            aria-valuenow={Math.min(requested, accepted)}
            className="mt-3 h-1 overflow-hidden bg-muted"
          >
            <div
              className="h-full bg-success"
              style={{ width: `${Math.min(100, (accepted / requested) * 100)}%` }}
            />
          </div>
        )}
        <p
          className={cn(
            "mt-3 text-xs leading-5",
            stopped ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {batchMessage(status)}
          {!terminal &&
            (!status.tasks || counts.unknown > 0) &&
            " Some task activity is unavailable; last known stages appear below."}
        </p>
      </div>

      {discovery && (
        <details
          className="group border-t border-border px-4 py-3"
          open={status.phase === "discovering"}
        >
          <summary className="flex cursor-pointer list-none items-start gap-2 text-xs [&::-webkit-details-marker]:hidden">
            <ChevronDown
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium">Finding Task Candidates</span>
              <span className="mt-1 block text-muted-foreground">
                Scanning repository history · Wave {discovery.wave + 1}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {finishedDiscovery} of {discovery.totalShards} complete
            </span>
          </summary>
          <p className="mt-4 pl-5 text-xs leading-5 text-muted-foreground">
            Searching repository changes for task candidates. This is discovery progress, not
            overall batch completion.
          </p>
          {discovery.totalShards > 0 && (
            <div
              role="progressbar"
              aria-label="Task Candidate Discovery Progress"
              aria-valuemin={0}
              aria-valuemax={discovery.totalShards}
              aria-valuenow={finishedDiscovery}
              className="mt-3 ml-5 flex h-1.5 overflow-hidden bg-muted"
            >
              <span
                className="bg-success"
                style={{ width: `${(discovery.completedShards / discovery.totalShards) * 100}%` }}
              />
              <span
                className="bg-destructive"
                style={{ width: `${(discovery.failedShards / discovery.totalShards) * 100}%` }}
              />
            </div>
          )}
          <div className="mt-3 ml-5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>{discovery.completedShards} complete</span>
            <span className={discovery.failedShards ? "text-destructive" : undefined}>
              {discovery.failedShards} failed
            </span>
            <span>{Math.max(0, discovery.totalShards - finishedDiscovery)} pending</span>
          </div>
        </details>
      )}
    </section>
  );
}
