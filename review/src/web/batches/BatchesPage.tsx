import { ArrowRight } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { GenerateBatch } from "../GenerateBatch";
import { ListSkeleton } from "../LoadingSkeleton";
import { useDocumentTitle } from "../session";
import { Button, EmptyState, Notice, PageContent, PageHeader } from "../ui";
import { useBatches } from "./BatchProvider";
import { BatchState, batchDate, batchName, batchPath } from "./presentation";

const columns =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_10rem_12rem_1rem]";
export function BatchesPage() {
  const { repoId, runs, statuses, errors, error, refreshing, refresh } = useBatches();
  const navigate = useNavigate();
  useDocumentTitle(`Batches · ${repoId.fullName} · self-bench`);
  return (
    <PageContent>
      <PageHeader title="Batches" description="Track task generation and revisit past batches.">
        <GenerateBatch
          repoId={repoId}
          onStarted={(runId, warning) => {
            refresh();
            void navigate(batchPath(repoId.fullName, runId), {
              state: { batchStartWarning: warning },
            });
          }}
        />
      </PageHeader>
      {error && (
        <Notice className="mb-4">
          {error}
          <Button disabled={refreshing} onClick={refresh}>
            Try Again
          </Button>
        </Notice>
      )}
      {!runs && !error && <ListSkeleton label="Loading Batches" />}
      {runs?.length === 0 && (
        <EmptyState title="No Batches Yet">
          Generate a batch to create tasks from repository changes.
        </EmptyState>
      )}
      {!!runs?.length && (
        <section className="border border-border bg-card" aria-label="Batch History">
          <div
            className={`${columns} border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground max-md:hidden`}
            aria-hidden="true"
          >
            <span>Batch</span>
            <span>Status</span>
            <span>Progress</span>
            <span />
          </div>
          <ul className="divide-y divide-border">
            {runs.map((run) => {
              const status = statuses[run.runId];
              return (
                <li key={run.runId}>
                  <Link
                    to={batchPath(repoId.fullName, run.runId)}
                    className={`${columns} items-center px-4 py-4 hover:bg-muted/50`}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{batchName(run.runId)}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        <time dateTime={run.attachedAt}>{batchDate(run.attachedAt)}</time> ·{" "}
                        {run.attachedBy}
                      </span>
                    </span>
                    <span className="max-md:col-start-1 max-md:row-start-2">
                      {errors[run.runId] ? (
                        <span className="text-xs text-destructive">Status Unavailable</span>
                      ) : (
                        <BatchState phase={status?.phase} />
                      )}
                    </span>
                    <span className="text-xs leading-5 text-muted-foreground max-md:col-start-1 max-md:row-start-3">
                      {status ? (
                        <>
                          <span>{status.discovered ?? "—"} Discovered</span>
                          <span className="mx-2 text-input">/</span>
                          <span>{status.accepted ?? "—"} Verified</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                    <ArrowRight
                      className="size-4 text-muted-foreground max-md:col-start-2 max-md:row-start-1"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </PageContent>
  );
}
