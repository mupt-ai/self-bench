import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../primitives/cn";
import type { EvaluationRun } from "./api";
import { CancelEvaluation } from "./CancelEvaluation";
import { CostValue } from "./CostValue";
import { DeleteRun } from "./DeleteRun";
import { OutcomeFilter } from "./ResultsFilters";
import { NoValue, ResultsStatus } from "./ResultsMarks";
import { DoneCell, sortedEntries, TaskHeadings, TaskRow, taskEntries } from "./ResultsTaskRows";
import { BATCH_CHEVRON, BATCH_INDENT, Elbow, TASK_INDENT, Toggle } from "./ResultsTree";
import { RetryErroredTasks } from "./RetryErroredTasks";
import { type Batch, type Outcome, type TaskResult, tally } from "./results-model";
import { momentLabel, outcomeSummary } from "./results-presentation";
import type { Sort } from "./results-view";

/** A run's heading: when it started, linking to its expanded table row, and its route. */
export function BatchHeading({ batch }: { batch: Batch }) {
  return (
    <>
      <Link
        className="group/run inline-flex shrink-0 items-center gap-1.5 font-semibold"
        to={`?run=${encodeURIComponent(batch.id)}`}
        title="Show Run"
      >
        {momentLabel(batch.createdAt)}
      </Link>
      <span className="truncate text-muted-foreground">{batch.route}</span>
    </>
  );
}

/** Who started some results' runs: one name, or a few. */
export function startersOf(results: readonly TaskResult[]): string {
  return [...new Set(results.map((result) => result.run.startedBy))].join(", ");
}

/**
 * A run under a configuration and its tasks when it's open, which can be filtered by result and
 * sorted.
 */
export function ResultGroupRows({
  name,
  heading,
  results,
  statusOf,
  open,
  shown,
  sort,
  onToggle,
  onToggleOutcome,
  onSort,
  onOpenTask,
  run,
  baseUrl,
  pages,
  onChanged,
}: {
  /** What the group is, for its toggle's label: "the Sep 29, 16:19 Run". */
  name: string;
  heading: ReactNode;
  results: readonly TaskResult[];
  /** What the status circle reads, when more than the results: tasks being run again, say. */
  statusOf?: readonly TaskResult[];
  open: boolean;
  /** The result states shown. */
  shown: ReadonlySet<Outcome>;
  sort: Sort | undefined;
  onToggle(): void;
  onToggleOutcome(outcome: Outcome): void;
  onSort(by: Sort["by"]): void;
  onOpenTask(result: TaskResult): void;
  run?: EvaluationRun | undefined;
  baseUrl?: string;
  /** Where the scope's pages live, for the comparison a retry starts. */
  pages?: string;
  onChanged?(run: EvaluationRun): void;
}) {
  const totals = tally(results);
  const live = run?.status === "running" || run?.status === "queued";
  const entries = taskEntries(results);
  // A row is one setting's share of its run: one harness.
  const harness = results[0]?.trial.harness;
  const tasks = sortedEntries(
    entries.filter((entry) => shown.has(entry.outcome)),
    sort,
  );
  return (
    <>
      <tr className="bg-muted/30" data-run-id={run?.id}>
        <td className={cn("relative", BATCH_INDENT)}>
          <Toggle
            open={open}
            chevron={BATCH_CHEVRON}
            label={`${open ? "Hide" : "Show"} Tasks for ${name}`}
            title={`${open ? "Hide" : "Show"} Tasks`}
            onToggle={onToggle}
          />
          <Elbow />
          <span className="block min-w-0">
            <span className="flex items-center gap-2 font-mono text-xs">{heading}</span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {outcomeSummary(results)}
            </span>
          </span>
        </td>
        <td>
          <ResultsStatus results={statusOf ?? results} />
        </td>
        <td className="truncate font-mono text-xs text-muted-foreground">{startersOf(results)}</td>
        <DoneCell finished={totals.finished} total={results.length} counts={totals.counts} />
        <td className="text-right font-mono tabular-nums">
          {totals.passRate === undefined ? <NoValue width={3} /> : `${totals.passRate.toFixed(0)}%`}
        </td>
        <td className="text-right font-mono tabular-nums">
          {totals.costPerTask === undefined ? (
            <NoValue width={6} />
          ) : (
            <CostValue value={totals.costPerTask} incomplete={totals.costIncomplete} />
          )}
        </td>
      </tr>
      {open && (
        <>
          {run && (run.error || (baseUrl && onChanged)) && (
            <tr>
              <td colSpan={6} className={TASK_INDENT}>
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">
                    {run.error ?? `${run.sandbox} · started by ${run.startedBy}`}
                  </span>
                  {baseUrl && onChanged && (
                    <span className="flex flex-wrap gap-2">
                      {pages && harness && (
                        <RetryErroredTasks
                          run={run}
                          harness={harness}
                          url={baseUrl}
                          pages={pages}
                        />
                      )}
                      {live && (
                        <CancelEvaluation<EvaluationRun>
                          endpoint={`${baseUrl}/${encodeURIComponent(run.id)}/cancel`}
                          subject="Run"
                          onCancelled={onChanged}
                        />
                      )}
                      <DeleteRun
                        endpoint={`${baseUrl}/${encodeURIComponent(run.id)}/delete`}
                        live={live}
                        onDeleted={onChanged}
                      />
                    </span>
                  )}
                </div>
              </td>
            </tr>
          )}
          <tr>
            <td colSpan={6} className={cn("relative", TASK_INDENT)}>
              <OutcomeFilter
                outcomes={entries.map((entry) => entry.outcome)}
                selected={shown}
                onToggle={onToggleOutcome}
              />
            </td>
          </tr>
          <TaskHeadings sort={sort} onSort={onSort} />
          {tasks.map((entry) => (
            <TaskRow key={entry.key} entry={entry} onOpen={onOpenTask} />
          ))}
        </>
      )}
    </>
  );
}
