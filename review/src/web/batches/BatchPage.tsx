import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useParams } from "react-router";
import { BatchProgress } from "../BatchProgress";
import { batchIsTerminal } from "../batch-api";
import { ListSkeleton } from "../LoadingSkeleton";
import { useDocumentTitle } from "../session";
import { Button, EmptyState, Notice, PageContent, PageHeader } from "../ui";
import { useBatches } from "./BatchProvider";
import { BatchTasks } from "./BatchTasks";
import { CancelBatch } from "./CancelBatch";
import { BatchState, batchDate, batchName, batchPath } from "./presentation";

export function BatchPage() {
  const { batchId = "" } = useParams();
  const { state } = useLocation();
  const { repoId, runs, statuses, errors, error, refreshing, refresh } = useBatches();
  const run = runs?.find((item) => item.runId === batchId);
  const status = statuses[batchId];
  const statusError = errors[batchId];
  useDocumentTitle(`${batchName(batchId)} · ${repoId.fullName} · self-bench`);
  return (
    <PageContent>
      <Link
        to={batchPath(repoId.fullName)}
        className="mb-5 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to Batches
      </Link>
      <PageHeader
        title={batchName(batchId)}
        description={
          run ? (
            <>
              <time dateTime={run.attachedAt}>{batchDate(run.attachedAt)}</time> · Started by{" "}
              {run.attachedBy}
            </>
          ) : undefined
        }
      >
        {status && !batchIsTerminal(status.phase) && (
          <CancelBatch key={batchId} repoId={repoId} runId={batchId} onCancelled={refresh} />
        )}
      </PageHeader>
      {!status && state?.batchStartWarning && (
        <Notice tone="info" className="mb-4">
          {state.batchStartWarning}
        </Notice>
      )}
      {(error || statusError) && (
        <Notice className="mb-4">
          <span>
            {status ? "Status could not be refreshed. Showing the last update. " : ""}
            {error || statusError}
          </span>
          <Button disabled={refreshing} onClick={refresh}>
            Try Again
          </Button>
        </Notice>
      )}
      {!run && !error && (runs === null || refreshing) && <ListSkeleton label="Loading Batch" />}
      {!run && runs !== null && !refreshing && !error && (
        <EmptyState title="Batch Not Found">This batch is not in this repository.</EmptyState>
      )}
      {run && !status && !statusError && <ListSkeleton label="Loading Batch Status" />}
      {run && status && (
        <>
          <div className="mb-4 flex items-center justify-between gap-3">
            <BatchState phase={status.phase} />
            {!batchIsTerminal(status.phase) && (
              <span className="text-xs text-muted-foreground">Updates Automatically</span>
            )}
          </div>
          {status.activity && (
            <div
              className="mb-4 border-l-2 border-brand bg-brand/5 px-4 py-3 text-sm"
              role="status"
            >
              {Object.values(status.activity).filter((state) => state === "running").length} running
              · {Object.values(status.activity).filter((state) => state === "queued").length} queued
            </div>
          )}
          <BatchProgress status={status} />
          <BatchTasks status={status} fullName={repoId.fullName} />
        </>
      )}
      {run && (
        <dl className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">
          <dt className="mb-1">Batch ID</dt>
          <dd className="break-all select-all">{run.runId}</dd>
        </dl>
      )}
    </PageContent>
  );
}
