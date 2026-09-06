import { Link } from "react-router";
import type { TaskItem } from "../api";
import { DifficultyStamp, StateStamp } from "./state";

/** The repo page's task rows; each links to the task's review. */
export function TaskList({ fullName, tasks }: { fullName: string; tasks: TaskItem[] }) {
  return (
    <ul className="list-none border border-line [&_li+li]:border-t [&_li+li]:border-line">
      {tasks.map((task) => (
        <li key={`${task.runId}:${task.taskId}`}>
          <Link
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-ink hover:bg-surface sm:flex-nowrap sm:gap-6"
            to={`/repos/${fullName}/tasks/${task.runId}/${encodeURIComponent(task.taskId)}`}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-mono text-[13px] font-medium">{task.taskId}</span>
              <span className="flex min-w-0 gap-3 font-mono text-[11px] text-dim">
                {task.sourcePr ? <span>PR #{task.sourcePr}</span> : null}
                <span className="font-mono">{task.runId}</span>
                {task.state === "in_progress" && (
                  <span className="whitespace-nowrap text-mint">
                    {task.stage}
                    {task.round ? ` · round ${task.round}` : ""}
                    {task.startedBy ? ` · started by ${task.startedBy}` : ""}
                  </span>
                )}
                {task.reasonSummary &&
                  task.state !== "accepted" &&
                  task.state !== "in_progress" && (
                    <span
                      className="truncate font-sans text-xs text-muted"
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
        </li>
      ))}
    </ul>
  );
}
