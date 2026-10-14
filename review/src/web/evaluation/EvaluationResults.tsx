import React from "react";
import { useSearchParams } from "react-router";
import { harnessLabels } from "../../../../src/evaluation/models";
import { DataTable, Notice, RunStatus } from "../ui";
import type { EvaluationRun, EvaluationTrial } from "./api";
import { CancelEvaluation } from "./CancelEvaluation";
import { OutcomeFilter, resultStates, toggledOutcome } from "./ResultsFilters";
import { OutcomeCircle } from "./ResultsMarks";
import { type Outcome, outcomeOf } from "./results-model";
import { findTrial, TRIAL_PARAM, trialParam } from "./results-view";
import { thinkingLabel } from "./run-presentation";
import { TrialDialog } from "./TrialDialog";

export function scores(trial: EvaluationTrial): string {
  const entries = Object.entries(trial.rewards);
  return entries.length
    ? entries.map(([name, value]) => `${name}: ${Number(value.toFixed(4))}`).join(" · ")
    : "Not Scored";
}
export function EvaluationResults({
  run,
  baseUrl,
  repo,
  onCancelled,
}: {
  run: EvaluationRun;
  baseUrl: string;
  repo: string;
  onCancelled?(run: EvaluationRun): void;
}) {
  const [search, setSearch] = useSearchParams();
  const opened = findTrial([run], search.get(TRIAL_PARAM));
  // The open task is in the URL, so going back to the run reopens it.
  const showTrial = (param: string | undefined) =>
    setSearch(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (param) next.set(TRIAL_PARAM, param);
        else next.delete(TRIAL_PARAM);
        return next;
      },
      { replace: true },
    );
  // The result filter is kept for the session, per run.
  const filterKey = `selfbench-run-results:${run.id}`;
  const [shown, setShown] = React.useState<ReadonlySet<Outcome>>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(filterKey) ?? "null");
      return new Set(Array.isArray(saved) ? saved : resultStates);
    } catch {
      return new Set(resultStates);
    }
  });
  React.useEffect(() => {
    try {
      sessionStorage.setItem(filterKey, JSON.stringify([...shown]));
    } catch {}
  }, [filterKey, shown]);
  const trials = run.trials.filter((entry) => shown.has(outcomeOf(entry)));
  const done = run.trials.filter((entry) => entry.status === "completed").length;
  // Errors, not failed tasks: a task the model didn't solve still completed.
  const errors = run.trials.filter((entry) => outcomeOf(entry) === "error").length;
  const errorCount = errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : "";
  const active = run.status === "queued" || run.status === "running";
  return (
    <section className="panel p-4 sm:p-6" aria-label="Evaluation Results">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-3 text-base font-semibold">
            {run.modelLabel} <RunStatus value={run.status} />
          </h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {run.sandbox} · {run.harnesses.map((harness) => harnessLabels[harness]).join(" + ")} ·
            started by {run.startedBy} · {new Date(run.createdAt).toLocaleString()}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Thinking: {thinkingLabel(run.thinking)} · Route:{" "}
            {run.credentials?.provider ?? run.modelName.split("/")[0]}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xs text-muted-foreground tabular-nums" role="status">
            {done}/{run.trials.length} completed{errorCount}
          </span>
          {active && onCancelled && (
            <CancelEvaluation
              endpoint={`${baseUrl}/${encodeURIComponent(run.id)}/cancel`}
              subject="Run"
              onCancelled={onCancelled}
            />
          )}
        </div>
      </header>
      {run.error && <Notice className="mt-4">{run.error}</Notice>}
      {active && (
        <div className="mt-4 border-l-2 border-brand bg-brand/[0.06] px-4 py-3" role="status">
          <p className="text-sm font-semibold">
            {run.status === "queued" ? "Queued" : "Running Now"}
          </p>
          <p
            className={`mt-1 text-sm text-muted-foreground ${run.status === "queued" ? "" : "font-mono"}`}
          >
            {run.status === "queued"
              ? "Waiting for an evaluation worker."
              : (run.trials.find((entry) => entry.status === "running")?.taskId ??
                "Preparing the evaluation environment…")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {run.trials.filter((entry) => entry.status === "queued").length} tasks queued · {done}{" "}
            completed{errorCount}
          </p>
        </div>
      )}
      <div className="mt-6">
        <div className="mb-3">
          <OutcomeFilter
            outcomes={run.trials.map(outcomeOf)}
            selected={shown}
            onToggle={(outcome) => setShown((set) => toggledOutcome(set, outcome))}
          />
        </div>
        <DataTable className="min-w-[600px] [&_button]:text-left [&_button]:font-mono [&_button]:text-foreground [&_button]:wrap-anywhere [&_button:hover]:underline [&_button:hover]:underline-offset-4">
          <thead>
            <tr>
              <th>Task</th>
              <th>Harness</th>
              <th>Status</th>
              <th>Verifier Scores</th>
            </tr>
          </thead>
          <tbody>
            {trials.map((entry) => (
              <tr key={`${entry.runId}/${entry.taskId}/${entry.harness}`}>
                <td>
                  <button type="button" onClick={() => showTrial(trialParam(run, entry))}>
                    {entry.taskId}
                  </button>
                </td>
                <td>{harnessLabels[entry.harness]}</td>
                <td>
                  <OutcomeCircle outcome={outcomeOf(entry)} />
                </td>
                <td className="font-mono text-xs">{scores(entry)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      {opened && (
        <TrialDialog
          run={run}
          trial={opened.trial}
          baseUrl={baseUrl}
          repo={repo}
          onClose={() => showTrial(undefined)}
        />
      )}
    </section>
  );
}
