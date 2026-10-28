import { Link } from "react-router";
import { ListSkeleton } from "../LoadingSkeleton";
import { useDocumentTitle } from "../session";
import { buttonStyles, EmptyState, Notice, PageContent, PageHeader } from "../ui";
import { ChartPreview } from "./ChartPreview";
import { GhostChart } from "./GhostChart";
import { ModelSummaries } from "./ModelSummaries";
import { useRepoRuns } from "./RepoRuns";
import { ResultsTable } from "./ResultsTable";
import { useEvaluationScope } from "./useEvaluationScope";

export function EvaluationPage() {
  const { repo, pages, label } = useEvaluationScope();
  const { url, runs, credentials, accepted, loading, error, update } = useRepoRuns();
  useDocumentTitle(`Results · ${label}`);
  return (
    <PageContent>
      <PageHeader
        title="Results"
        description="Inspect accuracy, cost, and what the solver did."
        className="mb-5"
      >
        {/* The header's chart preview has no room on a phone; this opens the same chart. */}
        <span className="md:hidden">
          <ChartPreview pages={pages} variant="button" />
        </span>
        <ModelSummaries />
      </PageHeader>
      {error && <Notice className="mb-4">{error}</Notice>}
      <ResultsTable
        // Open rows and the filter belong to one repository.
        key={`table:${url}`}
        runs={runs}
        credentials={credentials}
        {...(accepted ? { accepted } : {})}
        baseUrl={url}
        pages={pages}
        onChanged={update}
      />
      {loading && !runs.length && !error && (
        <div className="mt-8">
          <ListSkeleton label="Loading Runs" />
        </div>
      )}
      {/* Not when the list failed: the repository may have runs it could not show. */}
      {!loading && !error && !runs.length && (
        <EmptyState
          title="No Runs Yet"
          className="mt-6"
          visual={<GhostChart />}
          action={
            <>
              <Link className={buttonStyles.primary} to={`${pages}/run`}>
                Run Models
              </Link>
              {repo && (
                <Link className={buttonStyles.secondary} to={pages}>
                  Review Tasks
                </Link>
              )}
            </>
          }
        >
          {repo
            ? "Run models on this repository's approved tasks."
            : "Run models on datasets from Harbor's registry."}{" "}
          Each one lands on the chart by how many tasks it solved and what each task cost.
        </EmptyState>
      )}
    </PageContent>
  );
}
