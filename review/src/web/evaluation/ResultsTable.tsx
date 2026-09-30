import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { cn } from "../primitives/cn";
import { dollars } from "./benchmark";
import { BatchRows } from "./ResultsBatchRows";
import { ConfigurationName, Flags, StatusPill } from "./ResultsMarks";
import { needsAttention, type Review } from "./results-alerts";
import type { Configuration } from "./results-model";
import { configurationName } from "./results-presentation";

export interface TableView {
  /** Configurations whose batches are showing, by key. */
  open: ReadonlySet<string>;
  /** Batches showing every task, by configuration key and batch id. */
  showAll: ReadonlySet<string>;
  /** A task to show alone, from a task problem's Show button. */
  focusTask?: string;
  /** The configuration an alert's Show button pointed at. */
  highlight?: string;
}

/** The id of a configuration's row, for an alert's Show button to scroll to. */
export function rowId(configurations: readonly Configuration[], key: string): string {
  return `results-configuration-${configurations.findIndex((entry) => entry.key === key)}`;
}

export function ResultsTable({
  configurations,
  all,
  review,
  view,
  onToggle,
  onShowAll,
  onOpenRun,
}: {
  configurations: readonly Configuration[];
  /** Every configuration, for stable row ids whatever the filter. */
  all: readonly Configuration[];
  review: Review;
  view: TableView;
  onToggle(key: string): void;
  onShowAll(key: string, show: boolean): void;
  onOpenRun(runId: string): void;
}) {
  return (
    <section
      className="panel min-w-0 overflow-x-auto"
      aria-label="Scrollable Table"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide tables.
      tabIndex={0}
    >
      <table className="w-full min-w-[56rem] table-fixed border-collapse text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:whitespace-nowrap [&_th]:text-muted-foreground [&_thead]:bg-muted">
        <colgroup>
          <col className="w-[34%]" />
          <col className="w-40" />
          <col className="w-24" />
          <col className="w-24" />
          <col className="w-24" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Configuration</th>
            <th>Status</th>
            <th className="text-right">Done</th>
            <th className="text-right">Pass Rate</th>
            <th className="text-right">$/Task</th>
            <th className="text-right">Flags</th>
          </tr>
        </thead>
        <tbody>
          {configurations.map((configuration) => {
            const open = view.open.has(configuration.key);
            const name = configurationName(configuration);
            const batches = view.focusTask
              ? configuration.batches.filter((batch) =>
                  batch.results.some((result) => result.task === view.focusTask),
                )
              : configuration.batches;
            return (
              <Fragment key={configuration.key}>
                <tr
                  id={rowId(all, configuration.key)}
                  className={cn(
                    "scroll-mt-4 bg-card",
                    view.highlight === configuration.key && "bg-check/[0.12]",
                  )}
                >
                  <td>
                    <span className="flex min-w-0 items-center gap-1">
                      <button
                        type="button"
                        className="-ml-1.5 grid size-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                        aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} Batches for ${name}`}
                        title={`${open ? "Hide" : "Show"} Batches`}
                        onClick={() => onToggle(configuration.key)}
                      >
                        <ChevronRight
                          className={cn("size-3.5 transition-transform", open && "rotate-90")}
                          aria-hidden="true"
                        />
                      </button>
                      <ConfigurationName configuration={configuration} />
                    </span>
                  </td>
                  <td>
                    <StatusPill
                      status={configuration.status}
                      attention={needsAttention(review, configuration)}
                    />
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {configuration.finished}/{configuration.latest.length}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {configuration.passRate === undefined
                      ? "—"
                      : `${configuration.passRate.toFixed(0)}%`}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {configuration.costPerTask === undefined
                      ? "—"
                      : dollars(configuration.costPerTask)}
                  </td>
                  <td className="whitespace-normal!">
                    <Flags flags={review.flags.get(configuration.key) ?? []} />
                  </td>
                </tr>
                {open &&
                  batches.map((batch) => (
                    <BatchRows
                      key={batch.id}
                      configuration={configuration}
                      batch={batch}
                      review={review}
                      {...(view.focusTask ? { focusTask: view.focusTask } : {})}
                      showAll={view.showAll.has(`${configuration.key}\n${batch.id}`)}
                      onShowAll={(show) => onShowAll(`${configuration.key}\n${batch.id}`, show)}
                      onOpenRun={onOpenRun}
                    />
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
