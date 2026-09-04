import { Link } from "react-router";
import type { TaskItem } from "../api";
import { DifficultyStamp, StateStamp } from "./state";

/** The repo page's task rows; each links to the task's review. */
export function TaskList({ fullName, tasks }: { fullName: string; tasks: TaskItem[] }) {
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={`${task.runId}:${task.taskId}`}>
          <Link
            className="task-row"
            to={`/repos/${fullName}/tasks/${task.runId}/${encodeURIComponent(task.taskId)}`}
          >
            <span className="task-row-main">
              <span className="task-row-id">{task.taskId}</span>
              <span className="task-row-sub">
                {task.sourcePr ? <span>PR #{task.sourcePr}</span> : null}
                <span className="mono">{task.runId}</span>
                {task.state === "in_progress" && (
                  <span className="task-row-live">
                    {task.stage}
                    {task.round ? ` · round ${task.round}` : ""}
                    {task.startedBy ? ` · started by ${task.startedBy}` : ""}
                  </span>
                )}
                {task.reasonSummary &&
                  task.state !== "accepted" &&
                  task.state !== "in_progress" && (
                    <span className="task-row-reason" title={task.reasonSummary}>
                      {task.reasonSummary}
                    </span>
                  )}
              </span>
            </span>
            <span className="task-row-side">
              <DifficultyStamp difficulty={task.difficulty} />
              <StateStamp state={task.state} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
