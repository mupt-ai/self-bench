import React from "react";
import { Link, useParams } from "react-router";
import type { comparisonStatus } from "../../../../src/evaluation/comparisons";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, DataTable, PageContent, PageHeader } from "../ui";
import { evaluationRequest } from "./api";
import { useEvaluationScope } from "./useEvaluationScope";

export type ComparisonStatus = Awaited<ReturnType<typeof comparisonStatus>> & {
  submissionError?: string;
};
export function ComparisonPage() {
  const { repo, url } = useEvaluationScope();
  useDocumentTitle(`Comparison · ${repo}`);
  const { comparisonId } = useParams();
  const [status, setStatus] = React.useState<ComparisonStatus>();
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await evaluationRequest<ComparisonStatus>(
          `${url}/comparisons/${comparisonId}`,
        );
        if (!disposed) {
          setStatus(result);
          setError("");
        }
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not load comparison");
      }
    };
    setStatus(undefined);
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [url, comparisonId]);
  const resume = async () => {
    setBusy(true);
    try {
      const result = await evaluationRequest<ComparisonStatus>(
        `${url}/comparisons/${comparisonId}/resume`,
        {},
      );
      setStatus(result);
      setError(result.submissionError ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resume submission");
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageContent>
      <PageHeader
        title="Comparison"
        description="Saved independently of this page. Leaving does not cancel the runs."
      >
        <Link className={buttonStyles.secondary} to={`/repos/${repo}/results`}>
          Scores & Pareto
        </Link>
      </PageHeader>
      {error && (
        <p role="alert" className="my-4 font-mono text-sm text-danger">
          {error}
        </p>
      )}
      {!status && !error && <p>Loading comparison…</p>}
      {status && (
        <>
          <div className="min-w-0">
            <DataTable className="min-w-[850px]">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Harnesses</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {status.runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      {run.model}
                      <small>Thinking: {run.thinking ?? "Not Recorded"}</small>
                    </td>
                    <td>{run.harnesses.join(", ")}</td>
                    <td>
                      {run.status === "pending" ? "Awaiting worker / submission" : run.status}
                    </td>
                    <td>
                      {run.completed} / {run.trials} trials
                    </td>
                    <td>
                      <Link to={`/repos/${repo}/results?run=${run.id}`}>
                        Transcript, Scores & Artifacts →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
          {status.runs.some((run) => run.status === "pending" || run.status === "queued") && (
            <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
              <p className="mt-2 text-base text-muted">
                If submission was interrupted, resume reuses the same run IDs.
              </p>
              <Button type="button" variant="primary" disabled={busy} onClick={() => void resume()}>
                {busy ? "Resuming…" : "Resume Submission"}
              </Button>
            </div>
          )}
        </>
      )}
    </PageContent>
  );
}
