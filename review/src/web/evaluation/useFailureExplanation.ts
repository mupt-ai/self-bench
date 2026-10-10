import { useEffect, useState } from "react";
import { type EvaluationRun, type EvaluationTrial, evaluationRequest } from "./api";
import { outcomeOf } from "./results-model";

/** What the server says of one trial's explanation (src/api/routes/explain-trial.ts). */
interface ExplainState {
  available: boolean;
  running: boolean;
  reason?: string;
}

const POLL_MS = 4000;

/**
 * Explain Failure for one trial of `run`: whether the server offers it, asking for it, and
 * waiting while it runs. Waiting polls only the explanation's state; the run is fetched once it
 * ends, and handed to `onExplained` when it carries the explanation.
 */
export function useFailureExplanation({
  baseUrl,
  run,
  trial,
  enabled,
  onExplained,
}: {
  baseUrl: string;
  run: Pick<EvaluationRun, "id">;
  trial: EvaluationTrial;
  /** Whether this deployment may offer explanations at all (its managed offering). */
  enabled: boolean;
  onExplained(run: EvaluationRun): void;
}) {
  const [state, setState] = useState<ExplainState>();
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState("");
  const wanted = enabled && outcomeOf(trial) === "failed" && !trial.failureSummary;
  const endpoint = `${baseUrl}/${encodeURIComponent(run.id)}/explain`;
  const { runId, taskId, harness } = trial;
  const query = new URLSearchParams({ runId, taskId, harness }).toString();

  // What the server offers for this trial, and whether its explanation is already running.
  useEffect(() => {
    if (!wanted) return;
    let disposed = false;
    evaluationRequest<ExplainState>(`${endpoint}?${query}`).then(
      (answer) => {
        if (disposed) return;
        setState(answer);
        if (answer.running) setExplaining(true);
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [wanted, endpoint, query]);

  useEffect(() => {
    if (!explaining) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const answer = await evaluationRequest<ExplainState>(`${endpoint}?${query}`);
        if (disposed) return;
        if (answer.running) {
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        const latest = await evaluationRequest<EvaluationRun>(
          `${baseUrl}/${encodeURIComponent(run.id)}`,
        );
        if (disposed) return;
        const done = latest.trials.find(
          (entry) => entry.runId === runId && entry.taskId === taskId && entry.harness === harness,
        );
        setExplaining(false);
        if (done?.failureSummary) onExplained(latest);
        else {
          setState(answer);
          setError("No explanation came back. Try again in a few minutes.");
        }
      } catch (cause) {
        if (disposed) return;
        setExplaining(false);
        setError(cause instanceof Error ? cause.message : "Could not check the explanation");
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [explaining, endpoint, query, baseUrl, run.id, runId, taskId, harness, onExplained]);

  const explain = async () => {
    setError("");
    try {
      await evaluationRequest(endpoint, { runId, taskId, harness });
      setExplaining(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the explanation");
    }
  };

  return {
    offered: wanted && (explaining || state?.available === true),
    explaining,
    error,
    explain,
  };
}
