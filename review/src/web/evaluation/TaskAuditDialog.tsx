import { useRef } from "react";
import { Dialog, DialogHeader } from "../Dialog";
import { useSession } from "../session";
import { Notice } from "../ui";
import { FailureExplanationForm } from "./FailureExplanationForm";
import { OutcomeCircle } from "./ResultsMarks";
import type { Configuration, TaskResult } from "./results-model";
import { configurationDetail, momentLabel, taskParts } from "./results-presentation";
import type { OutcomeGridTask } from "./TaskOutcomeGrid";
import { taskPage } from "./TrialDialog";
import { useTaskAudit } from "./useTaskAudit";

const AUDIT = { action: "Audit Task", busy: "Auditing…", model: "Audit Model" };
const VERDICTS = { fair: "Fair", unfair: "Unfair", unclear: "Unclear" } as const;

/**
 * One task across every configuration that attempted it: each attempt, opening its trial, and
 * Audit Task, which has a model judge from all the failed attempts whether the task is fair.
 */
export function TaskAuditDialog({
  task,
  configurations,
  baseUrl,
  pages,
  onClose,
  onOpenTrial,
}: {
  task: OutcomeGridTask;
  configurations: readonly Configuration[];
  baseUrl: string;
  /** Where the scope's pages live; only a repository's tasks are audited. */
  pages: string;
  onClose(): void;
  onOpenTrial(result: TaskResult): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const { session } = useSession();
  const auditable = !pages.startsWith("/benchmarks/");
  const enabled = auditable && session.status === "signed-in";
  const { state, auditing, error, audit } = useTaskAudit({
    baseUrl,
    runId: task.runId,
    taskId: task.id,
    enabled,
  });
  const rows = configurations.flatMap((configuration) =>
    configuration.batches
      .flatMap((batch) => batch.results.filter((result) => result.task === task.key))
      .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
      .map((result) => ({ configuration, result })),
  );
  const scored = rows.filter(({ result }) => ["passed", "failed"].includes(result.outcome));
  const failed = scored.filter(({ result }) => result.outcome === "failed").length;
  const auditableFailures = scored.filter(
    ({ result }) =>
      result.outcome === "failed" &&
      result.trial.status === "completed" &&
      result.trial.modelVerified !== false &&
      result.trial.rewards.reward === 0,
  ).length;
  const parts = taskParts(task.id);
  const last = state?.audit;
  // Offered from the failures the server can audit, without waiting for state to load.
  const offered = auditing || (enabled && auditableFailures > 0 && state?.available !== false);
  const reason =
    state?.reason ??
    (auditableFailures ? undefined : "No verified failed attempt is available to audit.");
  return (
    <Dialog
      initialFocus={close}
      onDismiss={onClose}
      size="wide"
      className="min-w-0 font-sans [&_header_h2]:break-words"
      aria-labelledby="task-audit-title"
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
            {parts.name}
            {parts.title && (
              <span className="ml-2 text-base font-normal text-muted-foreground">
                {parts.title}
              </span>
            )}
          </>
        }
        titleId="task-audit-title"
        description={`${failed} of ${scored.length} scored ${scored.length === 1 ? "attempt" : "attempts"} failed`}
        onClose={onClose}
        closeRef={close}
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-3 text-sm sm:px-6">
        <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
        <a
          className="ml-auto text-sm font-medium underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground"
          href={taskPage(pages, { runId: task.runId, taskId: task.id })}
          target="_blank"
          rel="noopener"
        >
          View Task
        </a>
      </div>
      <div className="min-w-0 space-y-6 p-4 sm:p-6">
        {auditable && (
          <section aria-label="Audit" className="space-y-3">
            {last && (
              <div className="space-y-1.5">
                <h3 className="text-sm font-semibold">Verdict: {VERDICTS[last.verdict]}</h3>
                <p className="text-sm leading-6">{last.text}</p>
                <p className="text-xs text-muted-foreground">
                  {last.model} read {last.failures} failed of {last.attempts} scored{" "}
                  {last.attempts === 1 ? "attempt" : "attempts"} · {momentLabel(last.auditedAt)}
                </p>
              </div>
            )}
            {offered ? (
              <FailureExplanationForm
                baseUrl={baseUrl}
                explaining={auditing}
                onExplain={audit}
                labels={last ? { ...AUDIT, action: "Audit Again" } : AUDIT}
              />
            ) : (
              reason && <p className="text-sm text-muted-foreground">{reason}</p>
            )}
            {error && <Notice>{error}</Notice>}
          </section>
        )}
        <section aria-labelledby="task-attempts" className="space-y-2">
          <h3 id="task-attempts" className="text-sm font-semibold">
            Attempts
          </h3>
          <ul className="divide-y divide-border panel">
            {rows.map(({ configuration, result }) => (
              <li key={`${configuration.key}/${result.run.id}`}>
                <button
                  type="button"
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground"
                  onClick={() => onOpenTrial(result)}
                >
                  <OutcomeCircle outcome={result.outcome} bare />
                  <span className="min-w-0">
                    <span className="font-medium">{configuration.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {configurationDetail(configuration)}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {momentLabel(result.run.createdAt)}
                  </span>
                  {result.trial.failureSummary && (
                    <span className="col-start-2 col-end-4 line-clamp-2 text-xs text-muted-foreground">
                      {result.trial.failureSummary.text}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
