import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../primitives/cn";
import { dollars } from "./benchmark";
import { OutcomeFilter } from "./ResultsFilters";
import { NoValue, ResultsStatus } from "./ResultsMarks";
import { DoneCell, sortedEntries, TaskHeadings, TaskRow, taskEntries } from "./ResultsTaskRows";
import { BATCH_CHEVRON, BATCH_INDENT, Elbow, TASK_INDENT, Toggle } from "./ResultsTree";
import { type MissingTask, withMissing } from "./results-coverage";
import { type Batch, type Outcome, type TaskResult, tally } from "./results-model";
import { momentLabel, outcomeSummary } from "./results-presentation";
import type { Sort } from "./results-view";

/** A run's heading: when it started, linking to it, marked as a link out, and its route. */
export function BatchHeading({ batch }: { batch: Batch }) {
  return (
    <>
      <Link
        className="group/run inline-flex shrink-0 items-center gap-1.5 font-semibold"
        to={`?run=${encodeURIComponent(batch.id)}`}
        title="Open Run"
      >
        {/* Says the title opens the run's own page. */}
        <ExternalLink
          className="size-3 shrink-0 text-muted-foreground group-hover/run:text-foreground"
          aria-hidden="true"
        />
        {momentLabel(batch.createdAt)}
      </Link>
      <span className="truncate text-muted-foreground">{batch.route}</span>
    </>
  );
}

/** " · 36 left out · 4 added later": the accepted tasks a configuration has no result for. */
function notRun(missing: readonly MissingTask[]): string {
  const count = (outcome: MissingTask["outcome"]) =>
    missing.filter((task) => task.outcome === outcome).length;
  return [
    count("unrun") ? ` · ${count("unrun")} left out` : "",
    count("added") ? ` · ${count("added")} added later` : "",
  ].join("");
}

/** Who started some results' runs: one name, or a few. */
export function startersOf(results: readonly TaskResult[]): string {
  return [...new Set(results.map((result) => result.run.startedBy))].join(", ");
}

/**
 * A group of results under a configuration (a batch, or the cumulative results) and its tasks
 * when it's open, which can be filtered by result and sorted. The cumulative results also list
 * the accepted tasks the configuration hasn't run, as Left Out or Added Later, filtered out at
 * first.
 */
export function ResultGroupRows({
  name,
  heading,
  results,
  statusOf,
  cumulative = false,
  missing = [],
  unsolved,
  open,
  shown,
  sort,
  onToggle,
  onToggleOutcome,
  onSort,
  onOpenTask,
}: {
  /** What the group is, for its toggle's label: "the Sep 29, 16:19 Run". */
  name: string;
  heading: ReactNode;
  results: readonly TaskResult[];
  /** What the status circle reads, when more than the results: tasks being run again, say. */
  statusOf?: readonly TaskResult[];
  /** Whether these are each task's latest results, from all the configuration's runs. */
  cumulative?: boolean;
  /** Accepted tasks with no result here, listed as Left Out or Added Later. */
  missing?: readonly MissingTask[];
  /** Accepted tasks no configuration passed, though enough ran them, by task key (`unsolvedOf`). */
  unsolved?: ReadonlyMap<string, number>;
  open: boolean;
  /** The result states shown. */
  shown: ReadonlySet<Outcome>;
  sort: Sort | undefined;
  onToggle(): void;
  onToggleOutcome(outcome: Outcome): void;
  onSort(by: Sort["by"]): void;
  onOpenTask(result: TaskResult): void;
}) {
  const totals = tally(results);
  const entries = taskEntries(results, missing);
  const tasks = sortedEntries(
    entries.filter((entry) => shown.has(entry.outcome)),
    sort,
  );
  return (
    <>
      <tr className="bg-muted/30">
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
              {cumulative && notRun(missing)}
            </span>
          </span>
        </td>
        <td>
          <ResultsStatus results={statusOf ?? results} />
        </td>
        <td className="truncate font-mono text-xs text-muted-foreground">{startersOf(results)}</td>
        <DoneCell
          finished={totals.finished}
          total={results.length + missing.length}
          counts={withMissing(totals.counts, missing)}
        />
        <td className="text-right font-mono tabular-nums">
          {totals.passRate === undefined ? <NoValue width={3} /> : `${totals.passRate.toFixed(0)}%`}
        </td>
        <td className="text-right font-mono tabular-nums">
          {totals.costPerTask === undefined ? <NoValue width={6} /> : dollars(totals.costPerTask)}
        </td>
      </tr>
      {open && (
        <>
          <tr>
            <td colSpan={6} className={cn("relative", TASK_INDENT)}>
              <OutcomeFilter
                outcomes={entries.map((entry) => entry.outcome)}
                selected={shown}
                coverage={cumulative}
                onToggle={onToggleOutcome}
              />
            </td>
          </tr>
          <TaskHeadings cumulative={cumulative} sort={sort} onSort={onSort} />
          {tasks.map((entry) => (
            <TaskRow
              key={entry.key}
              entry={entry}
              cumulative={cumulative}
              unsolved={entry.result && unsolved?.get(entry.result.task)}
              onOpen={onOpenTask}
            />
          ))}
        </>
      )}
    </>
  );
}
