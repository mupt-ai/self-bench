import React from "react";
import { Link, useParams } from "react-router";
import type { comparisonStatus } from "../../../../src/evaluation/comparisons";
import { harnessLabels } from "../../../../src/evaluation/harnesses";
import { ListSkeleton } from "../LoadingSkeleton";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, Notice, PageContent, PageHeader } from "../ui";
import { EvaluationRequestError, evaluationRequest } from "./api";
import { unlockMissingComparison } from "./comparison-submission";
import { thinkingLabel } from "./run-presentation";
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
  const [missing, setMissing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await evaluationRequest<ComparisonStatus>(
          `${url}/comparisons/${comparisonId}`,
        );
        if (!disposed) {
          setMissing(false);
          setStatus(result);
          setError("");
        }
      } catch (cause) {
        if (
          !disposed &&
          cause instanceof EvaluationRequestError &&
          cause.status === 404 &&
          comparisonId
        ) {
          unlockMissingComparison(url, comparisonId);
          setMissing(true);
        }
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not load comparison");
      }
    };
    setStatus(undefined);
    setMissing(false);
    setError("");
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
        description={
          status
            ? `${status.runs.filter((run) => run.status === "completed").length} of ${status.runs.length} runs complete · ${status.runs.filter((run) => run.status === "running").length} running · ${status.runs.filter((run) => run.status === "queued" || run.status === "pending").length} waiting`
            : ""
        }
      >
        <Link className={buttonStyles.secondary} to={`/repos/${repo}/results`}>
          View Results
        </Link>
      </PageHeader>
      {missing ? (
        <Notice className="mb-4">
          <p>This comparison could not be found. Return to Run to review your selection.</p>
          <Link
            className="font-semibold text-foreground underline underline-offset-4"
            to={`/repos/${repo}/run`}
          >
            Back to Run
          </Link>
        </Notice>
      ) : (
        error && <Notice className="mb-4">{error}</Notice>
      )}
      {!status && !error && <ListSkeleton label="Loading Comparison" />}
      {status && (
        <>
          <div className="panel divide-y divide-border">
            {[...status.runs]
              .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"))
              .map((run) => (
                <Link
                  key={run.id}
                  to={`/repos/${repo}/results?run=${run.id}`}
                  className={`block min-w-0 px-4 py-3.5 hover:bg-muted/60 ${run.status === "running" ? "border-l-2 border-l-brand" : ""}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="min-w-0 break-all font-mono text-sm font-medium">{run.model}</h2>
                    <span
                      className={
                        run.status === "running"
                          ? "text-xs font-semibold text-brand-foreground"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {run.status === "running"
                        ? "Running Now"
                        : run.status === "pending"
                          ? "Not Submitted"
                          : run.status === "queued"
                            ? "Queued"
                            : run.status === "completed"
                              ? "Completed"
                              : "Failed"}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {run.harnesses.map((harness) => harnessLabels[harness]).join(" + ")} · Thinking:{" "}
                    {thinkingLabel(run.thinking)}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                    {run.completed} / {run.trials} trials finished
                    {run.status === "queued" ? " · Waiting for a worker" : ""}
                  </p>
                </Link>
              ))}
          </div>
          {status.runs.some((run) => run.status === "pending" || run.status === "queued") && (
            <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
              <p className="mt-2 text-sm text-muted-foreground">
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
