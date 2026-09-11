import type { BatchStatus } from "./batch-api";
import { batchMessage } from "./batches/presentation";
import { cn } from "./primitives/cn";

/** Progress belongs on the batch page; creation only collects the next batch's settings. */
export function BatchProgress({ status }: { status: BatchStatus }) {
  const discovery = status.discovery;
  const stopped = status.phase === "blocked" || status.phase === "failed";
  const finished = discovery
    ? Math.min(discovery.totalShards, discovery.completedShards + discovery.failedShards)
    : 0;
  return (
    <section className="border border-border bg-card" aria-label="Batch Progress">
      <div className="border-b border-border p-4 sm:p-5">
        <p
          className={cn(
            "max-w-3xl break-words text-sm leading-6",
            stopped ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {batchMessage(status)}
        </p>
      </div>
      <dl className="grid grid-cols-2 border-b border-border md:grid-cols-4">
        {(
          [
            ["Requested", status.requested],
            ["Discovered", status.discovered],
            ["Verified", status.accepted],
            ["Rejected", status.rejected],
          ] as const
        ).map(([label, count], index) => (
          <div
            key={label}
            className={cn(
              "min-w-0 border-border px-4 py-5 sm:px-5",
              index % 2 === 0 && "border-r border-border",
              index < 2 && "max-md:border-b",
              index === 1 && "md:border-r",
            )}
          >
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-2 text-2xl font-medium tabular-nums">{count ?? "—"}</dd>
          </div>
        ))}
      </dl>
      {discovery && (
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <h2 className="font-medium">Discovery · Wave {discovery.wave + 1}</h2>
            <span className="text-muted-foreground">
              {finished} / {discovery.totalShards} Shards Finished
            </span>
          </div>
          {discovery.totalShards > 0 && (
            <div
              role="progressbar"
              aria-label="Discovery Shards Finished"
              aria-valuemin={0}
              aria-valuemax={discovery.totalShards}
              aria-valuenow={finished}
              className="flex h-1.5 overflow-hidden bg-muted"
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
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>{discovery.completedShards} Complete</span>
            <span className={discovery.failedShards ? "text-destructive" : undefined}>
              {discovery.failedShards} Failed
            </span>
            <span>{Math.max(0, discovery.totalShards - finished)} Pending</span>
          </div>
        </div>
      )}
      {status.requestedByDifficulty && (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5">
          Requested: {status.requestedByDifficulty.easy} easy ·{" "}
          {status.requestedByDifficulty.medium} medium · {status.requestedByDifficulty.hard} hard
        </p>
      )}
    </section>
  );
}
