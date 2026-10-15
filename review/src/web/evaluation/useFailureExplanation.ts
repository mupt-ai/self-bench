import { useCallback, useEffect, useState } from "react";
import { type EvaluationRun, type EvaluationTrial, evaluationRequest } from "./api";
import { outcomeOf } from "./results-model";

/** What the server says of one trial's explanation (src/api/routes/explain-trial.ts). */
interface ExplainState {
  available: boolean;
  running: boolean;
  reason?: string;
  /** Explained since the run this page holds was read. */
  explained?: boolean;
}

export interface ExplanationSelection {
  credentialId: string;
  /** A catalog model ID, or the raw model ID for a custom endpoint. */
  model: string;
}

const POLL_MS = 4000;

/**
 * Explain Failure for one trial of the evaluation `evaluationId`: whether the server offers it,
 * asking for it, and waiting while it runs. Waiting polls only the explanation's state; the run is
 * fetched once it ends, and handed to `onExplained` when it carries the explanation.
 */
export function useFailureExplanation({
  baseUrl,
  evaluationId,
  trial,
  enabled,
  onExplained,
}: {
  baseUrl: string;
  evaluationId: string;
  trial: EvaluationTrial;
  /** Whether a signed-in user has loaded the trial. */
  enabled: boolean;
  onExplained(run: EvaluationRun): void;
}) {
  const [state, setState] = useState<ExplainState>();
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState("");
  const wanted = enabled && outcomeOf(trial) === "failed" && !trial.failureSummary;
  const runUrl = `${baseUrl}/${encodeURIComponent(evaluationId)}`;
  const { runId, taskId, harness } = trial;
  const stateUrl = `${runUrl}/explain?${new URLSearchParams({ runId, taskId, harness })}`;

  // What the server offers for this trial: a run read before its explanation was written gets it.
  const check = useCallback(
    async (live: () => boolean) => {
      const answer = await evaluationRequest<ExplainState>(stateUrl);
      if (!live()) return;
      setState(answer);
      setExplaining(answer.running);
      if (!answer.explained) return;
      const latest = await evaluationRequest<EvaluationRun>(runUrl);
      if (!live()) return;
      // Whatever refused it, the trial is explained now.
      setError("");
      onExplained(latest);
    },
    [stateUrl, runUrl, onExplained],
  );
  useEffect(() => {
    setState(undefined);
    setExplaining(false);
    setError("");
    if (!wanted) return;
    let disposed = false;
    check(() => !disposed).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [wanted, check]);

  useEffect(() => {
    if (!explaining) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const answer = await evaluationRequest<ExplainState>(stateUrl);
        if (disposed) return;
        if (answer.running) {
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        const latest = await evaluationRequest<EvaluationRun>(runUrl);
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
  }, [explaining, stateUrl, runUrl, runId, taskId, harness, onExplained]);

  const explain = async (explanation: ExplanationSelection) => {
    if (!wanted || explaining || !state?.available) return;
    setError("");
    try {
      await evaluationRequest(`${runUrl}/explain`, { runId, taskId, harness, explanation });
      setExplaining(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the explanation");
      // Refused, perhaps because it was explained meanwhile: show what the server has now.
      await check(() => true).catch(() => undefined);
    }
  };

  return {
    offered: wanted && (explaining || state?.available === true),
    explaining,
    error,
    reason: wanted && !explaining ? state?.reason : undefined,
    explain,
  };
}
