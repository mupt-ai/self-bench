import type { Dispatch, SetStateAction } from "react";
import { dollars } from "./benchmark";
import type { AcceptedTask } from "./RepoRuns";
import { BatchHeading, ResultGroupRows, startersOf } from "./ResultsBatchRows";
import { resultStates } from "./ResultsFilters";
import { ConfigurationName, NoValue, ResultsStatus } from "./ResultsMarks";
import { DoneCell } from "./ResultsTaskRows";
import { BATCH_INDENT, CONFIGURATION_CHEVRON, Elbow, Toggle } from "./ResultsTree";
import { missingTasks, withMissing } from "./results-coverage";
import type { Configuration, TaskResult } from "./results-model";
import { configurationName, momentLabel } from "./results-presentation";
import { nextOrder, type ResultsView } from "./results-view";

/** Runs listed when a configuration opens; more show a few at a time. */
const FIRST_RUNS = 5;
const MORE_RUNS = 10;

const flipped = <T,>(list: readonly T[], item: T) =>
  list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];

/**
 * A configuration's row and, while it's open, its Cumulative Results (each task's latest result,
 * and optionally the accepted tasks it hasn't run) and then its runs, newest first.
 */
export function ConfigurationRows({
  configuration,
  accepted,
  view,
  setView,
  onOpenTask,
}: {
  configuration: Configuration;
  /** The repository's accepted tasks, for the ones the cumulative results haven't run. */
  accepted: readonly AcceptedTask[] | undefined;
  view: ResultsView;
  setView: Dispatch<SetStateAction<ResultsView>>;
  onOpenTask(result: TaskResult): void;
}) {
  const open = view.configurations.includes(configuration.key);
  const missing = missingTasks(configuration, accepted);
  const runs = [...configuration.batches].reverse();
  const limit = view.runLimits[configuration.key] ?? FIRST_RUNS;
  const earlier = runs.length - limit;
  // The open state, result filter and sort of one group of results, by its key.
  const group = (key: string) => ({
    open: view.batches.includes(key),
    shown: new Set(view.shown[key] ?? resultStates),
    sort: view.sorts[key],
    onToggle: () => setView((current) => ({ ...current, batches: flipped(current.batches, key) })),
    onToggleOutcome: (outcome: TaskResult["outcome"]) =>
      setView((current) => ({
        ...current,
        shown: { ...current.shown, [key]: flipped(current.shown[key] ?? resultStates, outcome) },
      })),
    onSort: (by: "time" | "cost") =>
      setView((current) => {
        const { [key]: sort, ...sorts } = current.sorts;
        const next = nextOrder(sort, by);
        return { ...current, sorts: next ? { ...sorts, [key]: next } : sorts };
      }),
    onOpenTask,
  });
  return (
    <>
      <tr className="bg-card">
        <td className="relative pl-10!">
          <Toggle
            open={open}
            chevron={CONFIGURATION_CHEVRON}
            label={`${open ? "Hide" : "Show"} Runs for ${configurationName(configuration)}`}
            title={`${open ? "Hide" : "Show"} Runs`}
            onToggle={() =>
              setView((current) => ({
                ...current,
                configurations: flipped(current.configurations, configuration.key),
              }))
            }
          />
          <ConfigurationName configuration={configuration} />
        </td>
        <td>
          <ResultsStatus results={[...configuration.latest, ...configuration.underway]} />
        </td>
        <td className="truncate font-mono text-xs text-muted-foreground">
          {startersOf(configuration.latest)}
        </td>
        {/* Out of every accepted task, so a configuration that ran only some shows it. */}
        <DoneCell
          finished={configuration.finished}
          total={configuration.latest.length + missing.length}
          counts={withMissing(configuration.counts, missing)}
        />
        <td className="text-right font-mono tabular-nums">
          {configuration.passRate === undefined ? (
            <NoValue width={3} />
          ) : (
            `${configuration.passRate.toFixed(0)}%`
          )}
        </td>
        <td className="text-right font-mono tabular-nums">
          {configuration.costPerTask === undefined ? (
            <NoValue width={6} />
          ) : (
            dollars(configuration.costPerTask)
          )}
        </td>
      </tr>
      {open && (
        <ResultGroupRows
          name="the Cumulative Results"
          heading={<b className="font-semibold">Cumulative Results</b>}
          results={configuration.latest}
          statusOf={[...configuration.latest, ...configuration.underway]}
          cumulative
          missing={missing}
          {...group(`${configuration.key}\nlatest`)}
        />
      )}
      {open &&
        runs
          .slice(0, limit)
          .map((batch) => (
            <ResultGroupRows
              key={batch.id}
              name={`the ${momentLabel(batch.createdAt)} Run`}
              heading={<BatchHeading batch={batch} />}
              results={batch.results}
              {...group(`${configuration.key}\n${batch.id}`)}
            />
          ))}
      {open && earlier > 0 && (
        <tr className="bg-muted/30">
          <td colSpan={6} className={`relative ${BATCH_INDENT}`}>
            <Elbow />
            <button
              type="button"
              className="border border-border bg-card px-2.5 py-1 text-xs font-semibold hover:bg-foreground/[0.06]"
              onClick={() =>
                setView((current) => ({
                  ...current,
                  runLimits: { ...current.runLimits, [configuration.key]: limit + MORE_RUNS },
                }))
              }
            >
              Show {Math.min(MORE_RUNS, earlier)} Earlier Run
              {Math.min(MORE_RUNS, earlier) === 1 ? "" : "s"}
            </button>
            <span className="ml-3 text-xs text-muted-foreground">{earlier} more in all</span>
          </td>
        </tr>
      )}
    </>
  );
}
