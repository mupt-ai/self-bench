import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { type BatchStatus, batchIsTerminal } from "../batch-api";
import { cn } from "../primitives/cn";
import { DifficultyStamp } from "../task/state";
import { taskTitle } from "../task/task-title";
import { Button, EmptyState, SectionHeader } from "../ui";
import { activityCounts, activityLabels, type TaskActivity, taskActivity } from "./task-activity";

const taskLabels = {
  queued: "Not Started",
  authoring: "Authoring",
  verifying: "Verifying",
  reviewing: "Reviewing",
  infrastructure_failed: "Failed",
  rejected: "Rejected",
  accepted: "Verified",
};
const order: TaskActivity[] = [
  "running",
  "queued",
  "unknown",
  "infrastructure_failed",
  "rejected",
  "stopped",
  "accepted",
];

export function BatchTasks({ status, fullName }: { status: BatchStatus; fullName: string }) {
  const [filter, setFilter] = useState<"all" | TaskActivity>("all");
  const counts = activityCounts(status);
  const tasks = [...(status.tasks ?? [])].sort(
    (a, b) => order.indexOf(taskActivity(status, a)) - order.indexOf(taskActivity(status, b)),
  );
  const visible = tasks.filter((task) => filter === "all" || taskActivity(status, task) === filter);
  return (
    <section className="mt-6">
      <SectionHeader title="Tasks" description="Running tasks first.">
        <Link
          to={`/repos/${fullName}`}
          className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          View Dataset <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </SectionHeader>
      {tasks.length > 0 && (
        <fieldset className="mb-3 flex flex-wrap gap-2" aria-label="Filter Tasks">
          {(["all", ...order] as const)
            .filter((key) => key === "all" || counts[key] > 0 || key === filter)
            .map((key) => (
              <Button
                key={key}
                size="small"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={filter === key ? "border-brand bg-brand/10 text-brand" : undefined}
              >
                {key === "all" ? "All Tasks" : key === "queued" ? "Queued" : activityLabels[key]}{" "}
                <span className="tabular-nums">{key === "all" ? tasks.length : counts[key]}</span>
              </Button>
            ))}
        </fieldset>
      )}
      {tasks.length ? (
        <>
          <div
            className="mb-2 hidden grid-cols-[minmax(0,1fr)_5rem_10rem_10rem] gap-3 px-4 text-xs text-muted-foreground lg:grid"
            aria-hidden="true"
          >
            <span>Task</span>
            <span>Difficulty</span>
            <span>Stage</span>
            <span>Activity or Result</span>
          </div>
          <ul
            className="divide-y divide-border border border-border bg-card"
            aria-label="Batch Tasks"
          >
            {visible.map((task) => {
              const activity = taskActivity(status, task);
              return (
                <li key={task.candidateId}>
                  <Link
                    to={`/repos/${fullName}/tasks/${encodeURIComponent(status.runId)}/${encodeURIComponent(task.taskId)}`}
                    className="grid items-center gap-3 px-4 py-4 hover:bg-muted/50 lg:grid-cols-[minmax(0,1fr)_5rem_10rem_10rem]"
                  >
                    <span className="min-w-0">
                      <span className="block break-words text-sm">
                        {taskTitle({ taskId: task.candidateId })}
                      </span>
                      {task.reason && (
                        <span className="mt-1 block break-words text-xs text-muted-foreground">
                          {task.reason}
                        </span>
                      )}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-5 gap-y-2 lg:contents">
                      <DifficultyStamp difficulty={task.difficulty} />
                      <span className="text-xs text-muted-foreground">
                        {taskLabels[task.status]}
                        {task.round !== undefined ? ` · Round ${task.round}` : ""}
                      </span>
                      <span
                        className={cn(
                          "text-xs",
                          activity === "running"
                            ? "text-brand"
                            : activity === "accepted"
                              ? "text-success"
                              : activity === "infrastructure_failed"
                                ? "text-destructive"
                                : "text-muted-foreground",
                        )}
                      >
                        {activityLabels[activity]}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {!visible.length && (
            <EmptyState title="No Matching Tasks">
              No tasks currently match this filter. Choose All Tasks to see the batch.
            </EmptyState>
          )}
        </>
      ) : (
        <EmptyState
          className="border-solid"
          title={
            status.tasks
              ? batchIsTerminal(status.phase)
                ? "No Tasks Generated"
                : "No Tasks Yet"
              : "Task Details Unavailable"
          }
        >
          {status.tasks && !batchIsTerminal(status.phase)
            ? "Tasks will appear here as generation progresses."
            : status.tasks
              ? "There are no tasks to review from this batch."
              : "Any saved tasks are available in the dataset."}
        </EmptyState>
      )}
    </section>
  );
}
