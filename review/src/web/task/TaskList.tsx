import { GitPullRequest } from "lucide-react";
import { Link } from "react-router";
import type { TaskItem } from "../api";
import { cn } from "../primitives/cn";
import { DifficultyStamp, StateStamp } from "./state";
import { TaskRowActions } from "./TaskRowActions";
import { taskKey } from "./task-deletion";
import { taskDetailsLayout, taskRowLayout } from "./task-list-layout";

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
    <div>
      <TaskListHeader />
      <ul className="list-none divide-y divide-border" aria-label="Dataset Tasks">
        {tasks.map((task) => (
          <li
            key={taskKey(task)}
            data-selected={selected.has(taskKey(task))}
            className={cn(
              taskRowLayout,
              "group border-border transition-colors hover:bg-muted/50 data-[selected=true]:bg-brand/5",
            )}
          >
            <input
              type="checkbox"
              className="size-4 accent-brand"
              aria-label={`Select ${task.taskId} from ${task.runId}`}
              checked={selected.has(taskKey(task))}
              disabled={busy || task.pipelineStatus === "in_progress"}
              onChange={(event) => onSelect(task, event.target.checked)}
            />
            <Link
              className={cn(
                taskDetailsLayout,
                "py-3 text-foreground outline-offset-4 focus-visible:outline-brand",
              )}
              to={`/repos/${fullName}/tasks/${task.runId}/${encodeURIComponent(task.taskId)}`}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span
                  className="line-clamp-2 text-sm leading-6 font-medium wrap-anywhere md:line-clamp-1"
                  title={task.taskId}
                >
                  {task.taskId}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground">
                  {task.sourcePr && (
                    <span className="shrink-0 xl:hidden">
                      PR #{task.sourcePr}
                      <span className="ml-2 text-input">/</span>
                    </span>
                  )}
                  <span className="truncate" title={task.runId}>
                    {task.runId}
                  </span>
                </span>
                {task.state === "in_progress" ? (
                  <span className="truncate text-xs leading-5 text-muted-foreground">
                    {task.stage}
                    {task.round ? ` · round ${task.round}` : ""}
                    {task.startedBy ? ` · started by ${task.startedBy}` : ""}
                  </span>
                ) : task.reasonSummary && task.state !== "accepted" ? (
                  <span
                    className="truncate text-xs leading-5 text-muted-foreground"
                    title={task.reasonSummary}
                  >
                    {task.reasonSummary}
                  </span>
                ) : null}
              </span>
              <span className="hidden items-center gap-1.5 text-xs text-muted-foreground xl:flex">
                {task.sourcePr ? (
                  <>
                    <GitPullRequest className="size-3.5" aria-hidden="true" />#{task.sourcePr}
                  </>
                ) : (
                  "—"
                )}
              </span>
              <span className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-3 md:contents">
                <DifficultyStamp difficulty={task.difficulty} />
                <StateStamp state={task.state} />
              </span>
            </Link>
            <TaskRowActions
              task={task}
              disabled={busy || task.pipelineStatus === "in_progress"}
              onDelete={() => onDelete(task)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TaskListHeader() {
  return (
    <div
      className={cn(
        taskRowLayout,
        "hidden border-b border-border bg-muted/30 py-3 text-xs text-muted-foreground md:grid",
      )}
      aria-hidden="true"
    >
      <span />
      <div className={taskDetailsLayout}>
        <span>Task</span>
        <span className="hidden xl:block">Source</span>
        <span>Difficulty</span>
        <span>Status</span>
      </div>
      <span />
    </div>
  );
}
