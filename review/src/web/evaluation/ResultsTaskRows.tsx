import { Link, useNavigate, useParams } from "react-router";
import { cn } from "../primitives/cn";
import { dollars } from "./benchmark";
import { NoValue, OutcomeCircle, SortIcon, StateDetails } from "./ResultsMarks";
import { BATCH_CHEVRON, TASK_INDENT } from "./ResultsTree";
import type { MissingTask } from "./results-coverage";
import type { Outcome, TaskResult } from "./results-model";
import {
  errorMessage,
  minutesLabel,
  momentLabel,
  outcomeLabels,
  taskParts,
} from "./results-presentation";
import type { Sort } from "./results-view";

const link = "underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground";

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

/** A task under a batch or the cumulative results: its result, or an accepted task not yet run. */
export interface TaskEntry {
  key: string;
  runId: string;
  taskId: string;
  outcome: Outcome;
  result?: TaskResult;
  /** For a task not run, when it was accepted. */
  acceptedAt?: string;
}

export function taskEntries(
  results: readonly TaskResult[],
  missing: readonly MissingTask[] = [],
): TaskEntry[] {
  return [
    ...results.map((result) => ({
      key: `${result.run.id}/${result.task}`,
      runId: result.trial.runId,
      taskId: result.trial.taskId,
      outcome: result.outcome,
      result,
    })),
    ...missing.map((task) => ({
      key: `unrun/${task.runId}/${task.taskId}`,
      runId: task.runId,
      taskId: task.taskId,
      outcome: task.outcome,
      ...(task.acceptedAt ? { acceptedAt: task.acceptedAt } : {}),
    })),
  ];
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
    sort.by === "time" ? result?.minutes : result?.trial.apiCostUsd;
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

/** The headings over a group's tasks: who started and which run only for cumulative results. */
export function TaskHeadings({
  cumulative,
  sort,
  onSort,
}: {
  cumulative: boolean;
  sort: Sort | undefined;
  onSort(by: Sort["by"]): void;
}) {
  return (
    <tr className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase [&_td]:pt-1.5! [&_td]:pb-1!">
      <td colSpan={2} className={cn("relative", TASK_INDENT)}>
        Task
      </td>
      <td>{cumulative ? "Started By" : ""}</td>
      <td className="text-right">
        <SortHeading label="Time" by="time" sort={sort} onSort={onSort} />
      </td>
      <td className="text-right">{cumulative ? "Run" : ""}</td>
      <td className="text-right">
        <SortHeading label="Cost" by="cost" sort={sort} onSort={onSort} />
      </td>
    </tr>
  );
}

/**
 * A task's row: its result circle under the group's chevron, its name (opening its dialog, or for
 * a task not run, its page), and its time and cost. Cumulative rows also say who started the run
 * the result came from, and link to that run.
 */
export function TaskRow({
  entry,
  cumulative,
  unsolved,
  onOpen,
}: {
  entry: TaskEntry;
  cumulative: boolean;
  /** How many configurations ran the task, when enough did and none passed. */
  unsolved?: number;
  onOpen(result: TaskResult): void;
}) {
  const { owner = "", name = "" } = useParams();
  const navigate = useNavigate();
  const { result } = entry;
  const taskPage = `/repos/${owner}/${name}/tasks/${encodeURIComponent(entry.runId)}/${encodeURIComponent(entry.taskId)}`;
  const task = taskParts(entry.taskId);
  // A result that doesn't count is greyed: replaced by a later one, or, when it came after a
  // usable result that still counts, not counted.
  const counted = result?.replacedBy;
  const after = !!result && !!counted && result.run.createdAt > counted.run.createdAt;
  const title = (
    <>
      {task.name}
      {task.title && <span className="ml-2 text-muted-foreground">{task.title}</span>}
    </>
  );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the task's own button or link inside the row is the keyboard path; the row only widens the pointer target.
    <tr
      className={cn(
        "cursor-pointer text-xs hover:bg-foreground/[0.04]",
        (counted || !result) && "text-muted-foreground [&_[data-circle]]:opacity-50",
      )}
      // Anywhere on the row opens the task: its dialog, or for a task not run, its page. Links
      // and buttons inside it (the run's date) keep their own.
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button")) return;
        if (result) onOpen(result);
        else navigate(taskPage);
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
            : result?.outcome === "error"
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
        {result ? (
          <button
            type="button"
            className="max-w-full truncate text-left outline-none hover:underline hover:underline-offset-4 focus-visible:underline focus-visible:underline-offset-4"
            title={entry.taskId}
            onClick={() => onOpen(result)}
          >
            {title}
          </button>
        ) : (
          <Link
            className="outline-none hover:underline hover:underline-offset-4 focus-visible:underline focus-visible:underline-offset-4"
            title={
              entry.outcome === "added"
                ? `Accepted ${momentLabel(entry.acceptedAt ?? "")}, after this configuration last ran new tasks`
                : `Accepted${entry.acceptedAt ? ` ${momentLabel(entry.acceptedAt)}` : ""} before this configuration last ran new tasks, which left it out`
            }
            to={taskPage}
          >
            {title}
          </Link>
        )}
        {counted && (
          <span className="ml-2 border border-current px-1 py-px text-[10px] leading-none">
            {after ? "Not Counted" : "Replaced"}
          </span>
        )}
        {result?.trial.agentTimedOut && (
          <span
            className="ml-2 border border-current px-1 py-px text-[10px] leading-none"
            title="The agent reached its time limit and was scored on the work it had done"
          >
            Timed Out
          </span>
        )}
        {unsolved !== undefined && (
          <span
            className="ml-2 border border-current px-1 py-px text-[10px] leading-none text-warning"
            title={`None of the ${unsolved} configurations with an eligible result on this task passed it. Check its hidden tests.`}
          >
            Unsolved
          </span>
        )}
      </td>
      <td className="truncate font-mono text-muted-foreground">
        {cumulative && result ? result.run.startedBy : ""}
      </td>
      <td className="text-right font-mono tabular-nums">
        {!result ? (
          ""
        ) : result.minutes === undefined ? (
          <NoValue width={6} />
        ) : (
          minutesLabel(result.minutes)
        )}
      </td>
      <td className="text-right font-mono">
        {cumulative && result && (
          <Link
            className={cn("text-muted-foreground hover:text-foreground", link)}
            to={`?run=${encodeURIComponent(result.run.id)}`}
            title="Open Run"
          >
            {momentLabel(result.run.createdAt)}
          </Link>
        )}
      </td>
      <td className="text-right font-mono tabular-nums">
        {!result ? (
          ""
        ) : result.trial.apiCostUsd === undefined ? (
          <NoValue width={6} />
        ) : (
          dollars(result.trial.apiCostUsd)
        )}
      </td>
    </tr>
  );
}
