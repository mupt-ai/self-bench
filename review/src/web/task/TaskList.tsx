import { Link } from "react-router";
import type { TaskItem } from "../api";
import { DifficultyStamp, StateStamp } from "./state";
import { TrashIcon } from "./TrashIcon";
import { taskKey } from "./task-deletion";

/** The repo page's task rows; each links to the task's review. */
export function TaskList({
  fullName,
  tasks,
  selected,
  busy,
  onSelect,
  onDelete,
}: {
  fullName: string;
  tasks: TaskItem[];
  selected: ReadonlySet<string>;
  busy: boolean;
  onSelect: (task: TaskItem, checked: boolean) => void;
  onDelete: (task: TaskItem) => void;
}) {
  return (
    <ul className="list-none border border-line [&_li+li]:border-t [&_li+li]:border-line">
      {tasks.map((task) => (
        <li key={taskKey(task)} className="flex items-center gap-2 px-3 sm:gap-3">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-mint"
            aria-label={`Select ${task.taskId} from ${task.runId}`}
            checked={selected.has(taskKey(task))}
            disabled={busy || task.pipelineStatus === "in_progress"}
            onChange={(event) => onSelect(task, event.target.checked)}
          />
          <Link
            className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 py-3 text-ink hover:bg-surface sm:flex-nowrap sm:gap-6"
            to={`/repos/${fullName}/tasks/${task.runId}/${encodeURIComponent(task.taskId)}`}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-mono text-base font-medium">{task.taskId}</span>
              <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 break-all font-mono text-sm text-dim">
                {task.sourcePr ? <span>PR #{task.sourcePr}</span> : null}
                <span className="font-mono">{task.runId}</span>
                {task.state === "in_progress" && (
                  <span className="text-mint">
                    {task.stage}
                    {task.round ? ` · round ${task.round}` : ""}
                    {task.startedBy ? ` · started by ${task.startedBy}` : ""}
                  </span>
                )}
                {task.reasonSummary &&
                  task.state !== "accepted" &&
                  task.state !== "in_progress" && (
                    <span
                      className="truncate font-sans text-sm text-muted"
                      title={task.reasonSummary}
                    >
                      {task.reasonSummary}
                    </span>
                  )}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2.5">
              <DifficultyStamp difficulty={task.difficulty} />
              <StateStamp state={task.state} />
            </span>
          </Link>
          <button
            type="button"
            className="inline-flex size-9 shrink-0 items-center justify-center text-danger hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Delete ${task.taskId} from ${task.runId}`}
            disabled={busy || task.pipelineStatus === "in_progress"}
            title={
              task.pipelineStatus === "in_progress"
                ? "Wait for task generation to finish"
                : `Delete ${task.taskId}`
            }
            onClick={() => onDelete(task)}
          >
            <TrashIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}
