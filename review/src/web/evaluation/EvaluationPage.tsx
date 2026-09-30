import React from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, EmptyState, Notice, PageContent, PageHeader, Select } from "../ui";
import { type EvaluationRun, evaluationRequest, evaluationUrl } from "./api";
import { benchmarkPoints, customEndpoints } from "./benchmark";
import { ComparisonHistory } from "./ComparisonHistory";
import { EvaluationResults } from "./EvaluationResults";
import { ParetoChart } from "./ParetoChart";
import { ResultsOverview } from "./ResultsOverview";

export function EvaluationPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const repo = `${owner}/${name}`;
  const url = evaluationUrl(org.login, repo);
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("run");
  const [runs, setRuns] = React.useState<EvaluationRun[]>([]);
  const [current, setCurrent] = React.useState<EvaluationRun>();
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [dataset, setDataset] = React.useState("");
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>([]);
  useDocumentTitle(`Results · ${repo}`);
  // Sign-ins and custom endpoints, for configurations and the chart. The page works without them.
  React.useEffect(() => {
    let disposed = false;
    evaluationRequest<{ credentials: CredentialInfo[] }>(
      `/api/orgs/${encodeURIComponent(org.login)}/credentials`,
    )
      .then((result) => {
        if (!disposed) setCredentials(result.credentials);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [org.login]);
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setRuns([]);
    setError("");
    const refresh = async () => {
      try {
        const result = await evaluationRequest<{ runs: EvaluationRun[] }>(url);
        if (disposed) return;
        setRuns(result.runs);
        setLoading(false);
        if (result.runs.some((run) => run.status === "queued" || run.status === "running"))
          timer = setTimeout(() => void refresh(), 3000);
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : "Could not load results");
          setLoading(false);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [url]);
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setCurrent(undefined);
    if (!selectedId) return;
    const refresh = async () => {
      try {
        const run = await evaluationRequest<EvaluationRun>(
          `${url}/${encodeURIComponent(selectedId)}`,
        );
        if (disposed) return;
        setCurrent(run);
        setError("");
        setRuns((history) => [run, ...history.filter((entry) => entry.id !== run.id)]);
        if (run.status === "queued" || run.status === "running")
          timer = setTimeout(() => void refresh(), 3000);
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : "Could not refresh run");
          timer = setTimeout(() => void refresh(), 10_000);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [url, selectedId]);
  const points = benchmarkPoints(runs);
  const datasets = [...new Set(points.map((point) => point.datasetKey))];
  const selectedDataset = datasets.includes(dataset) ? dataset : datasets[0];
  const comparable = points.filter((point) => point.datasetKey === selectedDataset);
  // A dataset by its size and when it was first run; its key is a hash of its tasks.
  const datasetLabel = (key: string) => {
    const tasks = points.find((point) => point.datasetKey === key)?.tasks ?? 0;
    const first = runs
      .filter((run) => run.datasetKey === key)
      .reduce((earliest, run) => (run.createdAt < earliest ? run.createdAt : earliest), "9999");
    const since = new Date(first).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${tasks} task${tasks === 1 ? "" : "s"} · since ${since}`;
  };
  return (
    <PageContent>
      <PageHeader title="Results" description="Compare your runs. Inspect what the solver did.">
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
          <ResultsOverview
            runs={runs}
            credentials={credentials}
            onOpenRun={(id) => setSearch({ run: id })}
          >
            {datasets.length > 1 && (
              <label
                htmlFor="evaluationpage-field-0"
                className="mb-4 flex flex-wrap items-center gap-3.5 text-sm font-medium text-muted-foreground"
              >
                Compare Dataset
                <Select
                  id="evaluationpage-field-0"
                  value={selectedDataset}
                  onChange={(event) => setDataset(event.target.value)}
                >
                  {datasets.map((key) => (
                    <option key={key} value={key}>
                      {datasetLabel(key)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <ParetoChart
              points={comparable}
              endpoints={customEndpoints(comparable, credentials)}
              onSelect={(id) => setSearch({ run: id })}
            />
          </ResultsOverview>
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
          <ComparisonHistory key={url} repo={repo} url={url} />
        </>
      )}
    </PageContent>
  );
}
