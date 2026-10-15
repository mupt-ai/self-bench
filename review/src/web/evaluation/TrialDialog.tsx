import { useCallback, useEffect, useRef, useState } from "react";
import { findModel } from "../../../../src/contracts/models";
import { harnessLabels } from "../../../../src/evaluation/models";
import { Dialog, DialogHeader } from "../Dialog";
import { ListSkeleton } from "../LoadingSkeleton";
import { useSession } from "../session";
import { Notice } from "../ui";
import { type EvaluationRun, type EvaluationTrial, evaluationRequest } from "./api";
import { CostValue } from "./CostValue";
import { FailureExplanationForm } from "./FailureExplanationForm";
import { OutcomeCircle } from "./ResultsMarks";
import { outcomeOf } from "./results-model";
import { routeLabel, taskParts } from "./results-presentation";
import { thinkingLabel } from "./run-presentation";
import { TrialDetails } from "./TrialDetails";
import { useFailureExplanation } from "./useFailureExplanation";

type TrialIdentity = Pick<EvaluationTrial, "runId" | "taskId" | "harness">;
const sameTrial = (a: TrialIdentity, b: TrialIdentity) =>
  a.runId === b.runId && a.taskId === b.taskId && a.harness === b.harness;

/**
 * The task's own page, which the dialog opens in a new tab. A benchmark's tasks are known by name
 * alone; a repository's by batch and name.
 */
export const taskPage = (
  pages: string,
  { runId, taskId }: Pick<EvaluationTrial, "runId" | "taskId">,
) =>
  pages.startsWith("/benchmarks/")
    ? `${pages}/tasks/${taskId}`
    : `${pages}/tasks/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}`;

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
export function TrialDialog(props: TrialDialogProps) {
  const { run, trial, baseUrl } = props;
  return (
    <TrialDialogContent
      key={`${baseUrl}/${run.id}/${trial.runId}/${trial.taskId}/${trial.harness}`}
      {...props}
    />
  );
}

type TrialDialogProps = {
  run: EvaluationRun;
  trial: EvaluationTrial;
  /** Whether `run` already has every trial's transcript and logs. */
  loaded?: boolean;
  baseUrl: string;
  /** Where the run's pages live: `/repos/<owner>/<name>`, or `/benchmarks`. */
  pages: string;
  onClose(): void;
  /** The run, once it carries the explanation this dialog asked for. */
  onExplained?(run: EvaluationRun): void;
};

function TrialDialogContent({
  run: known,
  trial: chosen,
  loaded = false,
  baseUrl,
  pages,
  onClose,
  onExplained,
}: TrialDialogProps) {
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
    evaluationId: known.id,
    trial,
    enabled: !!run && session.status === "signed-in",
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
      className="min-w-0 font-sans [&_header_h2]:break-words"
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
              <span className="ml-2 text-base font-normal text-muted-foreground">{task.title}</span>
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
            <CostValue value={trial.apiCostUsd} incomplete={trial.costIncomplete} />
          </span>
        )}
        <a
          className="ml-auto text-sm font-medium underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground"
          href={taskPage(pages, trial)}
          target="_blank"
          rel="noopener"
        >
          View Task
        </a>
      </div>
      <div className="min-w-0 p-4 sm:p-6">
        {explanation.offered && (
          <FailureExplanationForm
            key={`${baseUrl}/${known.id}/${trial.runId}/${trial.taskId}/${trial.harness}`}
            baseUrl={baseUrl}
            explaining={explanation.explaining}
            onExplain={explanation.explain}
          />
        )}
        {explanation.reason && (
          <p className="mb-4 text-sm text-muted-foreground">{explanation.reason}</p>
        )}
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
