import { cn } from "../primitives/cn";
import { CostValue } from "./CostValue";
import { NoValue, OutcomeCircle, SortIcon, StateDetails } from "./ResultsMarks";
import { BATCH_CHEVRON, TASK_INDENT } from "./ResultsTree";
import type { Outcome, TaskResult } from "./results-model";
import {
  errorMessage,
  minutesLabel,
  momentLabel,
  outcomeLabels,
  taskParts,
} from "./results-presentation";
import type { Sort } from "./results-view";

/** A Done cell: tasks finished out of all of them, then details of any other states in play. */
export function DoneCell({
  finished,
  total,
  counts,
}: {
  finished: number;
  total: number;
  counts: Readonly<Partial<Record<Outcome, number>>>;
}) {
  return (
    <td className="text-right font-mono tabular-nums">
      <span className="inline-flex items-center justify-end gap-1.5">
        {finished}/{total}
        <StateDetails counts={counts} finished={finished} total={total} />
      </span>
    </td>
  );
}

/** A task under a run: its result. */
export interface TaskEntry {
  key: string;
  taskId: string;
  outcome: Outcome;
  result: TaskResult;
}

export function taskEntries(results: readonly TaskResult[]): TaskEntry[] {
  return results.map((result) => ({
    key: `${result.run.id}/${result.task}`,
    taskId: result.trial.taskId,
    outcome: result.outcome,
    result,
  }));
}

/** Tasks by pull request number when their ids name one, else by id. */
function byTask(a: TaskEntry, b: TaskEntry): number {
  const number = (entry: TaskEntry) =>
    Number(/(?:^|-)pr-(\d+)/.exec(entry.taskId)?.[1] ?? Number.POSITIVE_INFINITY);
  return number(a) - number(b) || a.taskId.localeCompare(b.taskId);
}

/** By time or cost, with tasks that have none last either way; ties stay in task order. */
export function sortedEntries(entries: readonly TaskEntry[], sort: Sort | undefined): TaskEntry[] {
  const tasks = [...entries].sort(byTask);
  if (!sort) return tasks;
  const value = ({ result }: TaskEntry) =>
    sort.by === "time" ? result.minutes : result.trial.apiCostUsd;
  return tasks.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    return sort.descending ? y - x : x - y;
  });
}

function SortHeading({
  label,
  by,
  sort,
  onSort,
}: {
  label: string;
  by: Sort["by"];
  sort: Sort | undefined;
  onSort(by: Sort["by"]): void;
}) {
  const active = sort?.by === by ? (sort.descending ? "descending" : "ascending") : undefined;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 uppercase hover:text-foreground",
        active && "text-foreground",
      )}
      aria-label={`Sort by ${label}`}
      onClick={() => onSort(by)}
    >
      {label}
      <SortIcon order={active} />
    </button>
  );
}

/** The headings over a run's tasks. */
export function TaskHeadings({
  sort,
  onSort,
}: {
  sort: Sort | undefined;
  onSort(by: Sort["by"]): void;
}) {
  return (
    <tr className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase [&_td]:pt-1.5! [&_td]:pb-1!">
      <td colSpan={2} className={cn("relative", TASK_INDENT)}>
        Task
      </td>
      <td />
      <td className="text-right">
        <SortHeading label="Time" by="time" sort={sort} onSort={onSort} />
      </td>
      <td />
      <td className="text-right">
        <SortHeading label="Cost" by="cost" sort={sort} onSort={onSort} />
      </td>
    </tr>
  );
}

/**
 * A task's row: its result circle under the run's chevron, its name (opening its dialog), and its
 * time and cost.
 */
export function TaskRow({ entry, onOpen }: { entry: TaskEntry; onOpen(result: TaskResult): void }) {
  const { result } = entry;
  const task = taskParts(entry.taskId);
  // A result that doesn't count is greyed: replaced by a later one, or, when it came after a
  // usable result that still counts, not counted.
  const counted = result.replacedBy;
  const after = !!counted && result.run.createdAt > counted.run.createdAt;
  return (
    <tr
      className={cn(
        "cursor-pointer text-xs hover:bg-foreground/[0.04]",
        counted && "text-muted-foreground [&_[data-circle]]:opacity-50",
      )}
      // Anywhere on the row opens the task's dialog.
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button")) return;
        onOpen(result);
      }}
      title={
        counted
          ? after
            ? `Not counted: the ${momentLabel(counted.run.createdAt)} run's ${outcomeLabels[counted.outcome]} still counts`
            : `Replaced by the ${momentLabel(counted.run.createdAt)} run: ${outcomeLabels[counted.outcome]}`
          : undefined
      }
    >
      <td
        colSpan={2}
        className={cn("relative truncate font-mono", TASK_INDENT)}
        title={
          counted
            ? undefined
            : result.outcome === "error"
              ? `Error: ${errorMessage(result.trial.error)}`
              : outcomeLabels[entry.outcome]
        }
      >
        <span
          className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2"
          style={{ left: BATCH_CHEVRON }}
        >
          <OutcomeCircle outcome={entry.outcome} bare />
        </span>
        <button
          type="button"
          className="max-w-full truncate text-left outline-none hover:underline hover:underline-offset-4 focus-visible:underline focus-visible:underline-offset-4"
          title={entry.taskId}
          onClick={() => onOpen(result)}
        >
          {task.name}
          {task.title && <span className="ml-2 text-muted-foreground">{task.title}</span>}
        </button>
        {counted && (
          <span className="ml-2 border border-current px-1 py-px text-[10px] leading-none">
            {after ? "Not Counted" : "Replaced"}
          </span>
        )}
        {result.trial.agentTimedOut && (
          <span
            className="ml-2 border border-current px-1 py-px text-[10px] leading-none"
            title="The agent reached its time limit and was scored on the work it had done"
          >
            Timed Out
          </span>
        )}
      </td>
      <td />
      <td className="text-right font-mono tabular-nums">
        {result.minutes === undefined ? <NoValue width={6} /> : minutesLabel(result.minutes)}
      </td>
      <td />
      <td className="text-right font-mono tabular-nums">
        {result.trial.apiCostUsd === undefined ? (
          <NoValue width={6} />
        ) : (
          <CostValue value={result.trial.apiCostUsd} incomplete={result.trial.costIncomplete} />
        )}
      </td>
    </tr>
  );
}
