import React from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, DataTable, PageContent, PageHeader, RunStatus, Select } from "../ui";
import { type EvaluationRun, evaluationRequest, evaluationUrl } from "./api";
import { benchmarkPoints, dollars, runAccuracy } from "./benchmark";
import { ComparisonHistory } from "./ComparisonHistory";
import { EvaluationResults } from "./EvaluationResults";
import { ParetoChart } from "./ParetoChart";

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
  useDocumentTitle(`Results · ${repo}`);
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
  return (
    <PageContent>
      <PageHeader title="Results" description="Compare your runs. Inspect what the solver did.">
        {selectedId && (
          <Button type="button" variant="secondary" onClick={() => setSearch({})}>
            All Results
          </Button>
        )}
      </PageHeader>
      {error && (
        <p className="my-4 font-mono text-base text-danger" role="alert">
          {error}
        </p>
      )}
      {selectedId ? (
        current ? (
          <EvaluationResults key={current.id} run={current} baseUrl={url} repo={repo} />
        ) : (
          !error && <ListSkeleton label="Loading Run" />
        )
      ) : (
        <>
          {datasets.length > 1 && (
            <label
              htmlFor="evaluationpage-field-0"
              className="mb-4 flex flex-wrap items-center gap-3.5 font-mono text-sm text-muted"
            >
              Compare Dataset
              <Select
                id="evaluationpage-field-0"
                value={selectedDataset}
                onChange={(event) => setDataset(event.target.value)}
              >
                {datasets.map((key) => (
                  <option key={key} value={key}>
                    {points.find((point) => point.datasetKey === key)?.tasks} tasks ·{" "}
                    {key.slice(0, 8)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <ParetoChart points={comparable} onSelect={(id) => setSearch({ run: id })} />
          <ComparisonHistory key={url} repo={repo} url={url} />
          <section className="mt-8 [&_h2]:mb-4">
            <h2>Runs</h2>
            {loading && !runs.length && !error && <ListSkeleton label="Loading Runs" />}
            {!loading && !runs.length && (
              <p className="mt-2 text-base text-muted">
                No runs yet. <Link to={`/repos/${repo}`}>Run Your Dataset →</Link>
              </p>
            )}
            {runs.length > 0 && (
              <div className="mt-3 font-mono [&_a]:text-ink [&_a:hover]:text-mint [&_button]:text-ink [&_button:hover]:text-mint">
                <DataTable>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Harness</th>
                      <th>Accuracy</th>
                      <th>Estimated Model Cost / Task</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.flatMap((run) =>
                      run.harnesses.map((harness) => {
                        const point = points.find(
                          (entry) => entry.runId === run.id && entry.harness === harness,
                        );
                        const accuracy = runAccuracy(run, harness);
                        return (
                          <tr key={`${run.id}/${harness}`}>
                            <td>
                              <button type="button" onClick={() => setSearch({ run: run.id })}>
                                {run.modelLabel}
                              </button>
                              <small>{new Date(run.createdAt).toLocaleString()}</small>
                            </td>
                            <td>{harness}</td>
                            <td>{accuracy === undefined ? "—" : `${accuracy.toFixed(1)}%`}</td>
                            <td>{point ? dollars(point.cost) : "Not Available"}</td>
                            <td>
                              <RunStatus value={run.status} />
                            </td>
                          </tr>
                        );
                      }),
                    )}
                  </tbody>
                </DataTable>
              </div>
            )}
          </section>
        </>
      )}
    </PageContent>
  );
}
