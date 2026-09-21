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
import { Discovery } from "./Discovery";
import { BatchState, batchDate, batchName, batchPath } from "./presentation";
import { repeatedFailure } from "./task-activity";

export function BatchPage() {
  const { batchId = "" } = useParams();
  const { state } = useLocation();
  const { repoId, runs, statuses, errors, error, refreshing, refresh } = useBatches();
  const run = runs?.find((item) => item.runId === batchId);
  const status = statuses[batchId];
  const statusError = errors[batchId];
  const repeated = status ? repeatedFailure(status) : undefined;
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
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            {batchName(batchId)}
            {status && <BatchState phase={status.phase} />}
          </span>
        }
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
      {run && status && repeated && (
        <Notice className="mb-4 flex-col items-start gap-1" aria-label="Repeated Task Failure">
          <span className="font-medium">{repeated.count} tasks are retrying the same error</span>
          <span className="min-w-0 break-words text-xs">{repeated.failure}</span>
        </Notice>
      )}
      {run && status && (
        <>
          <BatchProgress status={status} />
          <Discovery status={status} />
          <BatchTasks key={batchId} status={status} fullName={repoId.fullName} />
        </>
      )}
    </PageContent>
  );
}
