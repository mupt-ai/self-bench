import { Link, useParams } from "react-router";
import { ListSkeleton } from "../LoadingSkeleton";
import { useDocumentTitle } from "../session";
import { buttonStyles, EmptyState, Notice, PageContent, PageHeader } from "../ui";
import { ChartPreview } from "./ChartPreview";
import { ComparisonHistory } from "./ComparisonHistory";
import { GhostChart } from "./GhostChart";
import { useRepoRuns } from "./RepoRuns";
import { ResultsTable } from "./ResultsTable";

export function EvaluationPage() {
  const { owner = "", name = "" } = useParams();
  const repo = `${owner}/${name}`;
  const { url, runs, credentials, accepted, loading, error, update } = useRepoRuns();
  useDocumentTitle(`Results · ${repo}`);
  return (
    <PageContent>
      <PageHeader
        title="Results"
        description="Inspect accuracy, cost, and what the solver did."
        className="mb-5"
      >
        <span className="md:hidden">
          <ChartPreview repo={repo} variant="button" />
        </span>
      </PageHeader>
      {error && <Notice className="mb-4">{error}</Notice>}
      <ResultsTable
        key={`table:${url}`}
        runs={runs}
        credentials={credentials}
        {...(accepted ? { accepted } : {})}
        baseUrl={url}
        repo={repo}
        onChanged={update}
      />
      {loading && !runs.length && !error && (
        <div className="mt-8">
          <ListSkeleton label="Loading Runs" />
        </div>
      )}
      {!loading && !error && !runs.length && (
        <EmptyState
          title="No Runs Yet"
          className="mt-6"
          visual={<GhostChart />}
          action={
            <>
              <Link className={buttonStyles.primary} to={`/repos/${repo}/run`}>
                Run Models
              </Link>
              <Link className={buttonStyles.secondary} to={`/repos/${repo}`}>
                Review Tasks
              </Link>
            </>
          }
        >
          Run models on this repository's approved tasks. Each one lands on the chart by how many
          tasks it solved and what each task cost.
        </EmptyState>
      )}
      {!loading && <ComparisonHistory key={`history:${url}`} repo={repo} url={url} />}
    </PageContent>
  );
}
