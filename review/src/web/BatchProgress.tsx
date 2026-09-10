import React from "react";
import {
  type BatchRepoId,
  type BatchRun,
  type BatchStatus,
  batchIsTerminal,
  cancelBatch,
} from "./batch-api";
import { Skeleton } from "./LoadingSkeleton";
import { buttonStyles } from "./ui";

export function BatchProgress({
  run,
  status,
  repoId,
}: {
  run: BatchRun;
  status?: BatchStatus;
  repoId: BatchRepoId;
}) {
  const [cancelling, setCancelling] = React.useState(false);
  const [error, setError] = React.useState<string>();
  return (
    <section
      className="space-y-2 border border-line bg-bg p-4 text-sm text-muted"
      aria-label={`Batch ${run.runId}`}
    >
      <p className="break-all font-mono text-xs">{run.runId}</p>
      {!status && (
        <div role="status" aria-label="Loading Batch Progress">
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
      )}
      {status && (
        <p role="status">
          {status.phase}
          {status?.discovered !== undefined &&
            ` · ${status.discovered} discovered · ${status.accepted ?? 0} pipeline passed`}
        </p>
      )}
      {status?.discovery && (
        <p>
          Discovery wave {status.discovery.wave + 1}: {status.discovery.completedShards}/
          {status.discovery.totalShards} shards complete · {status.discovery.failedShards} failed
        </p>
      )}
      {status?.error && <p className="text-danger">{status.error}</p>}
      {status?.phase === "blocked" && !status.error && (
        <p className="text-danger">Discovery could not fill the requested candidate pool.</p>
      )}
      {!!status?.tasks?.length && (
        <ul>
          {status.tasks.map((task) => (
            <li key={task.candidateId}>
              {task.taskId} · {task.difficulty} ·{" "}
              {task.status === "accepted"
                ? "Needs Review"
                : `${task.status}${task.stage ? ` / ${task.stage}` : ""}`}
              {task.round !== undefined && ` · round ${task.round}`}
              {task.reason && <p className="text-danger">{task.reason}</p>}
            </li>
          ))}
        </ul>
      )}
      {(!status || !batchIsTerminal(status.phase)) && (
        <button
          type="button"
          className={buttonStyles.ghost}
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            setError(undefined);
            try {
              await cancelBatch(repoId, run.runId);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
              setCancelling(false);
            }
          }}
        >
          {cancelling ? "Cancellation Requested…" : "Cancel Batch"}
        </button>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
