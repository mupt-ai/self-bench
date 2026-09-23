import React from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { harnessLabels } from "../../../../src/evaluation/models";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import {
  Button,
  buttonStyles,
  DataTable,
  EmptyState,
  Notice,
  PageContent,
  PageHeader,
  RunStatus,
  SectionHeader,
  Select,
} from "../ui";
import { ActiveEvaluations } from "./ActiveEvaluations";
import { type EvaluationRun, evaluationRequest, evaluationUrl } from "./api";
import { benchmarkPoints, dollars, runAccuracy } from "./benchmark";
import { ComparisonHistory } from "./ComparisonHistory";
import { EvaluationResults } from "./EvaluationResults";
import { ParetoChart } from "./ParetoChart";
import { thinkingLabel } from "./run-presentation";

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
          <EvaluationResults key={current.id} run={current} baseUrl={url} repo={repo} />
        ) : (
          !error && <ListSkeleton label="Loading Run" />
        )
      ) : (
        <>
          <ActiveEvaluations runs={runs} repo={repo} />
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
                    {points.find((point) => point.datasetKey === key)?.tasks} tasks ·{" "}
                    {key.slice(0, 8)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <ParetoChart points={comparable} onSelect={(id) => setSearch({ run: id })} />
          <section className="mt-8">
            <SectionHeader title="Configuration × Task Results" />
            {runs.some((run) => run.trials.length > 0) && (
              <div className="mt-3 [&_button]:text-left [&_button]:font-semibold [&_button]:text-foreground [&_button:hover]:underline [&_button:hover]:underline-offset-4">
                <DataTable>
                  <thead>
                    <tr>
                      <th>Configuration</th>
                      <th>Task</th>
                      <th>Harness</th>
                      <th>Verifier Score</th>
                      <th>Model Cost</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.flatMap((run) =>
                      run.trials.map((trial) => (
                        <tr key={`${run.id}/${trial.runId}/${trial.taskId}/${trial.harness}`}>
                          <td>
                            <button type="button" onClick={() => setSearch({ run: run.id })}>
                              {run.modelLabel}
                            </button>
                            <small>
                              {run.modelName} · {run.sandbox} · {thinkingLabel(run.thinking)}
                            </small>
                          </td>
                          <td className="wrap-anywhere">
                            {trial.taskId}
                            <small>Run {trial.runId}</small>
                          </td>
                          <td>{harnessLabels[trial.harness]}</td>
                          <td>
                            {trial.rewards.reward === undefined
                              ? "Not Scored"
                              : trial.rewards.reward}
                          </td>
                          <td>
                            {trial.apiCostUsd === undefined
                              ? "Not Available"
                              : dollars(trial.apiCostUsd)}
                          </td>
                          <td>
                            <RunStatus value={trial.status} />
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </DataTable>
              </div>
            )}
          </section>
          <ComparisonHistory key={url} repo={repo} url={url} />
          <section className="mt-6">
            <SectionHeader title="Runs" />
            {loading && !runs.length && !error && <ListSkeleton label="Loading Runs" />}
            {!loading && !runs.length && (
              <EmptyState title="No Runs Yet">
                Choose models and a sandbox on the Run page to compare them against your dataset.
              </EmptyState>
            )}
            {runs.length > 0 && (
              <div className="mt-3 [&_button]:text-left [&_button]:font-semibold [&_button]:text-foreground [&_button:hover]:underline [&_button:hover]:underline-offset-4">
                <DataTable>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Harness</th>
                      <th>Thinking</th>
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
                            <td>{harnessLabels[harness]}</td>
                            <td>{thinkingLabel(run.thinking)}</td>
                            <td className="font-mono tabular-nums">
                              {accuracy === undefined ? "—" : `${accuracy.toFixed(1)}%`}
                            </td>
                            <td
                              className={point ? "font-mono tabular-nums" : "text-muted-foreground"}
                            >
                              {point ? dollars(point.cost) : "Not Available"}
                            </td>
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
