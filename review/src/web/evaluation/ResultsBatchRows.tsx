import type { ReactNode } from "react";
import { cn } from "../primitives/cn";
import { dollars } from "./benchmark";
import { OutcomePill, Tag } from "./ResultsMarks";
import { isTaskProblem, type Review } from "./results-alerts";
import type { Batch, Configuration, TaskResult } from "./results-model";
import {
  clockLabel,
  errorMessage,
  minutesLabel,
  momentLabel,
  outcomeLabels,
  outcomeSummary,
  taskParts,
} from "./results-presentation";

/** Tasks listed under a batch before the rest fold into one line. */
const LISTED = 6;

/** How urgently a task row needs listing, most urgent first; undefined folds it away. */
function urgency(result: TaskResult, stalled: boolean): number | undefined {
  if (result.outcome === "error" && !result.replacedBy) return 0;
  if (result.outcome === "running" && stalled) return 1;
  if (result.wontChart && !result.replacedBy) return 2;
  if (result.replacedBy || result.replaces) return 3;
  if (result.outcome === "running") return 4;
  return undefined;
}

function TaskNote({
  result,
  review,
  stalled,
}: {
  result: TaskResult;
  review: Review;
  stalled: boolean;
}) {
  const parts: ReactNode[] = [];
  const replaces = result.replaces;
  if (result.replacedBy) {
    const later = result.replacedBy;
    parts.push(
      `Replaced by the ${momentLabel(later.run.createdAt)} batch: ${outcomeLabels[later.outcome]}`,
    );
  } else if (isTaskProblem(review, result)) {
    const others = (review.taskProblems.get(result.task)?.configurations.length ?? 1) - 1;
    parts.push(
      <Tag key="tag" severity="task">
        Task Problem
      </Tag>,
      <q key="error" className="font-mono text-xs">
        {errorMessage(result.trial.error)}
      </q>,
      ` · also on ${others} other configuration${others === 1 ? "" : "s"}`,
    );
  } else if (result.outcome === "error") {
    parts.push(
      <q key="error" className="font-mono text-xs">
        {errorMessage(result.trial.error)}
      </q>,
    );
  } else if (result.wontChart) {
    parts.push(
      <Tag key="tag" severity="warn">
        Won’t Chart
      </Tag>,
      result.wontChart,
    );
  } else if (result.outcome === "running" && result.trial.startedAt) {
    if (stalled) {
      parts.push(
        <Tag key="tag" severity="warn">
          Stalled
        </Tag>,
      );
    }
    parts.push(
      <span key="since" className="text-muted-foreground">
        Running since {clockLabel(result.trial.startedAt)}
      </span>,
    );
  }
  if (replaces && !result.replacedBy) {
    const outcome = outcomeLabels[replaces.outcome].toLowerCase();
    parts.push(
      `${parts.length ? " · " : ""}Replaces the ${momentLabel(replaces.run.createdAt)} ${outcome}`,
    );
  }
  return <>{parts}</>;
}

function TaskRow({
  result,
  review,
  stalled,
  focused,
}: {
  result: TaskResult;
  review: Review;
  stalled: boolean;
  focused: boolean;
}) {
  const { trial } = result;
  const current = !result.replacedBy;
  const tone =
    current && result.outcome === "error"
      ? "shadow-[inset_3px_0_0_var(--bad-fg)]"
      : current && (result.wontChart || (stalled && result.outcome === "running"))
        ? "shadow-[inset_3px_0_0_var(--warn-fg)]"
        : "";
  const reward = trial.rewards.reward;
  const task = taskParts(trial.taskId);
  return (
    <tr
      className={cn(
        "text-xs",
        !current && "text-muted-foreground [&_[data-pip]]:opacity-50",
        focused && "bg-destructive/[0.06]",
      )}
    >
      <td className={cn("truncate pl-12! font-mono", tone)} title={trial.taskId}>
        {task.name}
        {task.title && <span className="ml-2 text-muted-foreground">{task.title}</span>}
      </td>
      <td>
        <OutcomePill outcome={result.outcome} />
      </td>
      <td className="text-right font-mono tabular-nums">
        {trial.status === "completed" && reward !== undefined ? reward : "—"}
      </td>
      <td
        className={cn(
          "text-right font-mono tabular-nums",
          stalled && result.outcome === "running" && current && "font-semibold text-warning",
        )}
      >
        {minutesLabel(result.minutes)}
      </td>
      <td className="text-right font-mono tabular-nums">
        {trial.apiCostUsd === undefined ? "—" : dollars(trial.apiCostUsd)}
      </td>
      <td className="whitespace-normal! leading-5">
        <TaskNote result={result} review={review} stalled={stalled && current} />
      </td>
    </tr>
  );
}

const quietButton =
  "ml-2.5 border border-border bg-transparent px-2 py-0.5 text-xs font-semibold text-foreground hover:bg-foreground/[0.06]";

/** A batch's row, and under it the tasks that need a look; the rest fold into one line. */
export function BatchRows({
  configuration,
  batch,
  review,
  focusTask,
  showAll,
  onShowAll,
  onOpenRun,
}: {
  configuration: Configuration;
  batch: Batch;
  review: Review;
  focusTask?: string;
  showAll: boolean;
  onShowAll(show: boolean): void;
  onOpenRun(runId: string): void;
}) {
  const stalled = review.stalls.has(configuration.key);
  const results = batch.results;
  let shown: TaskResult[];
  let hidden: TaskResult[] = [];
  if (focusTask) {
    shown = results.filter((result) => result.task === focusTask);
  } else if (showAll) {
    shown = results;
  } else {
    shown = results
      .flatMap((result) => {
        const rank = urgency(result, stalled);
        return rank === undefined ? [] : [{ result, rank }];
      })
      .sort((a, b) => a.rank - b.rank)
      .slice(0, LISTED)
      .map(({ result }) => result);
    hidden = results.filter((result) => !shown.includes(result));
  }
  const tasks = `${results.length} task${results.length === 1 ? "" : "s"}`;
  return (
    <>
      <tr className="bg-card/45 font-mono text-xs text-muted-foreground">
        <td colSpan={6} className="pl-9! whitespace-normal!">
          └ <b className="font-semibold text-foreground">{momentLabel(batch.createdAt)}</b> ·
          started by {batch.startedBy} · {tasks}
          <span className="ml-3">{outcomeSummary(results)}</span>
          {batch.runIds.map((runId, index) => (
            <button
              key={runId}
              type="button"
              className={quietButton}
              onClick={() => onOpenRun(runId)}
            >
              {batch.runIds.length > 1 ? `Open Run ${index + 1}` : "Open Run"}
            </button>
          ))}
        </td>
      </tr>
      {shown.length > 0 && (
        <tr className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase [&_td]:border-t-0! [&_td]:pt-1.5! [&_td]:pb-1!">
          <td className="pl-12!">Task</td>
          <td>Result</td>
          <td className="text-right">Reward</td>
          <td className="text-right">Time</td>
          <td className="text-right">Cost</td>
          <td>Note</td>
        </tr>
      )}
      {shown.map((result) => (
        <TaskRow
          key={`${result.run.id}/${result.task}`}
          result={result}
          review={review}
          stalled={stalled}
          focused={result.task === focusTask}
        />
      ))}
      {!focusTask && hidden.length > 0 && (
        <tr className="text-xs text-muted-foreground">
          <td colSpan={6} className="pl-12! whitespace-normal!">
            {shown.length ? `${hidden.length} more: ` : ""}
            {outcomeSummary(hidden)}
            <button type="button" className={quietButton} onClick={() => onShowAll(true)}>
              Show All {results.length} Tasks
            </button>
          </td>
        </tr>
      )}
      {!focusTask && showAll && results.length > LISTED && (
        <tr className="text-xs">
          <td colSpan={6} className="pl-12!">
            <button
              type="button"
              className={cn(quietButton, "ml-0")}
              onClick={() => onShowAll(false)}
            >
              Show Fewer
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
