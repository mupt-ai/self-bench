import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { FAILURE_SUMMARY_MODEL, findModel } from "../../../../src/contracts/models";
import { harnessLabels } from "../../../../src/evaluation/models";
import { Dialog, DialogHeader } from "../Dialog";
import { ListSkeleton } from "../LoadingSkeleton";
import { useSession } from "../session";
import { Button, buttonStyles, Notice } from "../ui";
import { type EvaluationRun, type EvaluationTrial, evaluationRequest } from "./api";
import { dollars } from "./benchmark";
import { OutcomeCircle } from "./ResultsMarks";
import { outcomeOf } from "./results-model";
import { routeLabel, taskParts } from "./results-presentation";
import { thinkingLabel } from "./run-presentation";
import { TrialDetails } from "./TrialDetails";
import { useFailureExplanation } from "./useFailureExplanation";

type TrialIdentity = Pick<EvaluationTrial, "runId" | "taskId" | "harness">;
const sameTrial = (a: TrialIdentity, b: TrialIdentity) =>
  a.runId === b.runId && a.taskId === b.taskId && a.harness === b.harness;

/** The model's catalog name, or a custom endpoint's typed name, as the table names it. */
function modelName(run: EvaluationRun): string {
  if (run.model === "custom") return run.modelName.replace(/^openai\//, "");
  return findModel(run.model)?.label ?? run.modelLabel;
}

/**
 * One task's trial in a dialog: what ran it, its result, and its transcript. The run list leaves
 * transcripts and logs out, so unless `loaded` says the run is complete, the dialog fetches it,
 * and keeps it fresh while it runs. A trial that failed its tests without an explanation offers
 * Explain Failure where the server can explain it (useFailureExplanation).
 */
export function TrialDialog({
  run: known,
  trial: chosen,
  loaded = false,
  showRun = false,
  baseUrl,
  repo,
  onClose,
  onExplained,
}: {
  run: EvaluationRun;
  trial: EvaluationTrial;
  /** Whether `run` already has every trial's transcript and logs. */
  loaded?: boolean;
  /** Whether to link to the run's page. */
  showRun?: boolean;
  baseUrl: string;
  repo: string;
  onClose(): void;
  /** The run, once it carries the explanation this dialog asked for. */
  onExplained?(run: EvaluationRun): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const { session } = useSession();
  const [fetched, setFetched] = useState<EvaluationRun>();
  const [explained, setExplained] = useState<EvaluationRun>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (loaded) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const run = await evaluationRequest<EvaluationRun>(
          `${baseUrl}/${encodeURIComponent(known.id)}`,
        );
        if (disposed) return;
        setFetched(run);
        if (run.status === "queued" || run.status === "running")
          timer = setTimeout(() => void refresh(), 3000);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load the run");
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [loaded, baseUrl, known.id]);
  const run = explained ?? (loaded ? known : fetched);
  const trial = run?.trials.find((entry) => sameTrial(entry, chosen)) ?? chosen;
  const explanation = useFailureExplanation({
    baseUrl,
    run: known,
    trial,
    enabled: !!run && session.status === "signed-in" && session.managedOffering,
    onExplained: useCallback(
      (latest: EvaluationRun) => {
        setExplained(latest);
        onExplained?.(latest);
      },
      [onExplained],
    ),
  });
  const task = taskParts(trial.taskId);
  const minutes =
    trial.startedAt && trial.finishedAt
      ? (Date.parse(trial.finishedAt) - Date.parse(trial.startedAt)) / 60_000
      : undefined;
  return (
    <Dialog
      initialFocus={close}
      onDismiss={onClose}
      size="wide"
      aria-labelledby="trial-title"
      // The app's dialogs ignore Escape (closedby="none"); this one closes on it.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <DialogHeader
        title={
          <>
            {task.name}
            {task.title && (
              <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
                {task.title}
              </span>
            )}
          </>
        }
        titleId="trial-title"
        description={[
          modelName(known),
          thinkingLabel(known.thinking),
          harnessLabels[trial.harness],
          routeLabel(known),
        ].join(" · ")}
        onClose={onClose}
        closeRef={close}
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-3 text-sm sm:px-6">
        <OutcomeCircle outcome={outcomeOf(trial)} />
        {minutes !== undefined && (
          <span className="font-mono text-xs text-muted-foreground">
            {Math.max(1, Math.round(minutes))} min
          </span>
        )}
        {trial.apiCostUsd !== undefined && (
          <span className="font-mono text-xs text-muted-foreground">
            {dollars(trial.apiCostUsd)}
          </span>
        )}
        <span className="ml-auto flex flex-wrap gap-2">
          {explanation.offered && (
            <Button
              disabled={explanation.explaining}
              onClick={() => void explanation.explain()}
              title={`Sends this trial's tests, reference solution and the solver's work to ${findModel(FAILURE_SUMMARY_MODEL)?.label ?? FAILURE_SUMMARY_MODEL} through SelfBench.`}
            >
              {explanation.explaining ? "Explaining…" : "Explain Failure"}
            </Button>
          )}
          {showRun && (
            <Link className={buttonStyles.secondary} to={`?run=${encodeURIComponent(known.id)}`}>
              Open Run
            </Link>
          )}
          <Link
            className={buttonStyles.secondary}
            to={`/repos/${repo}/tasks/${encodeURIComponent(trial.runId)}/${encodeURIComponent(trial.taskId)}`}
          >
            View Task ↗
          </Link>
        </span>
      </div>
      <div className="p-4 sm:p-6">
        {explanation.error && <Notice className="mb-4">{explanation.error}</Notice>}
        {error ? (
          <Notice>{error}</Notice>
        ) : run ? (
          <TrialDetails
            trial={trial}
            active={run.status === "queued" || run.status === "running"}
            agentMinutes={run.agentMinutes}
            artifactUrl={(name) =>
              `${baseUrl}/${run.id}/artifacts?name=${encodeURIComponent(name)}`
            }
          />
        ) : (
          <ListSkeleton label="Loading Transcript" />
        )}
      </div>
    </Dialog>
  );
}
