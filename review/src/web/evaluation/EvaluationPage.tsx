import React from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ListSkeleton } from "../LoadingSkeleton";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, EmptyState, Notice, PageContent, PageHeader } from "../ui";
import { type EvaluationRun, evaluationRequest } from "./api";
import { ChartPreview } from "./ChartPreview";
import { ComparisonHistory } from "./ComparisonHistory";
import { EvaluationResults } from "./EvaluationResults";
import { useRepoRuns } from "./RepoRuns";
import { ResultsTable } from "./ResultsTable";

export function EvaluationPage() {
  const { owner = "", name = "" } = useParams();
  const repo = `${owner}/${name}`;
  const { url, runs, credentials, accepted, loading, error: listError, update } = useRepoRuns();
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("run");
  const [current, setCurrent] = React.useState<EvaluationRun>();
  const [runError, setRunError] = React.useState("");
  // Each view shows its own load's error: a run that loaded isn't hidden by the list failing.
  const error = selectedId ? runError : listError;
  useDocumentTitle(`Results · ${repo}`);
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setCurrent(undefined);
    setRunError("");
    if (!selectedId) return;
    const refresh = async () => {
      try {
        const run = await evaluationRequest<EvaluationRun>(
          `${url}/${encodeURIComponent(selectedId)}`,
        );
        if (disposed) return;
        setCurrent(run);
        setRunError("");
        update(run);
        if (run.status === "queued" || run.status === "running")
          timer = setTimeout(() => void refresh(), 3000);
      } catch (cause) {
        if (!disposed) {
          setRunError(cause instanceof Error ? cause.message : "Could not refresh run");
          timer = setTimeout(() => void refresh(), 10_000);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [url, selectedId, update]);
  return (
    <PageContent>
      <PageHeader title="Results" description="Compare your runs. Inspect what the solver did.">
        {/* The header's chart preview has no room on a phone; this opens the same chart. */}
        <span className="md:hidden">
          <ChartPreview repo={repo} variant="button" />
        </span>
        <Link className={buttonStyles.secondary} to={`/repos/${repo}/releases?release=1`}>
          Release Results
        </Link>
        <Link className={buttonStyles.primary} to={`/repos/${repo}/run`}>
          New Comparison
        </Link>
        {selectedId && (
          <Button type="button" variant="secondary" onClick={() => setSearch({})}>
            All Results
          </Button>
        )}
      </PageHeader>
      {error && <Notice className="mb-4">{error}</Notice>}
      {selectedId ? (
        current ? (
          <EvaluationResults
            key={current.id}
            run={current}
            baseUrl={url}
            repo={repo}
            onCancelled={setCurrent}
          />
        ) : (
          !error && <ListSkeleton label="Loading Run" />
        )
      ) : (
        <>
          <ResultsTable
            // Open rows and the filter belong to one repository.
            key={url}
            runs={runs}
            credentials={credentials}
            {...(accepted ? { accepted } : {})}
            baseUrl={url}
            repo={repo}
          />
          {loading && !runs.length && !error && (
            <div className="mt-8">
              <ListSkeleton label="Loading Runs" />
            </div>
          )}
          {!loading && !runs.length && (
            <EmptyState title="No Runs Yet" className="mt-8">
              Choose models and a sandbox on the Run page to compare them against your dataset.
            </EmptyState>
          )}
          {/* Below the table once it has its rows, so it can tell whether it is in view. */}
          {!loading && <ComparisonHistory key={url} repo={repo} url={url} />}
        </>
      )}
    </PageContent>
  );
}
