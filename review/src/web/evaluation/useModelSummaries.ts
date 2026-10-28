import { useEffect, useState } from "react";
import type {
  ModelSummaryFailure,
  ModelSummaryReport,
} from "../../../../src/evaluation/model-summary";
import { evaluationRequest } from "./api";
import type { ExplanationSelection } from "./useFailureExplanation";

/** What the server says of the scope's model summaries (src/api/routes/model-summaries.ts). */
interface SummariesState {
  /** Whether this deployment writes summaries at all. */
  available: boolean;
  reason?: string;
  /** The configurations being summarized now. */
  running: string[];
  /** The latest report: what the configurations chosen together share, then each. */
  report?: ModelSummaryReport;
  /** Why the latest request gave no report, when it is newer than the report. */
  failure?: ModelSummaryFailure;
}

const POLL_MS = 4000;

/**
 * Model Summaries for the scope at `baseUrl`: the last report, asking for another, and waiting
 * while it is written, polling only its state.
 */
export function useModelSummaries({
  baseUrl,
  enabled,
}: {
  baseUrl: string;
  /** Whether a signed-in user has the summaries open. */
  enabled: boolean;
}) {
  const [state, setState] = useState<SummariesState>();
  const [error, setError] = useState("");
  const stateUrl = `${baseUrl}/summaries`;
  const running = state?.running ?? [];
  const writing = running.length > 0;

  useEffect(() => {
    setError("");
    if (!enabled) return;
    let disposed = false;
    evaluationRequest<SummariesState>(stateUrl).then(
      (answer) => {
        // Summaries started before this answer came back keep showing as running.
        if (!disposed)
          setState((current) => ({
            ...answer,
            running: answer.running.length ? answer.running : (current?.running ?? []),
          }));
      },
      (cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not load the summaries");
      },
    );
    return () => {
      disposed = true;
    };
  }, [enabled, stateUrl]);

  useEffect(() => {
    if (!enabled || !writing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const answer = await evaluationRequest<SummariesState>(stateUrl);
        if (disposed) return;
        setState(answer);
        if (answer.running.length) timer = setTimeout(() => void poll(), POLL_MS);
      } catch (cause) {
        if (disposed) return;
        setState((current) => current && { ...current, running: [] });
        setError(cause instanceof Error ? cause.message : "Could not check the summaries");
      }
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled, writing, stateUrl]);

  const summarize = async (configurations: readonly string[], summary: ExplanationSelection) => {
    if (writing || state?.available === false || !configurations.length) return;
    setError("");
    try {
      const started = await evaluationRequest<{ configurations: string[] }>(stateUrl, {
        configurations,
        summary,
      });
      setState((current) => ({ available: true, ...current, running: started.configurations }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the summaries");
      await evaluationRequest<SummariesState>(stateUrl)
        .then(setState)
        .catch(() => undefined);
    }
  };

  return { state, running, writing, error, summarize };
}
