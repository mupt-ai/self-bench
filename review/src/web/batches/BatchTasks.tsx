import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { type BatchStatus, batchIsTerminal } from "../batch-api";
import { DifficultyStamp } from "../task/state";
import { taskTitle } from "../task/task-title";
import { EmptyState, SectionHeader } from "../ui";

const taskLabels = {
  authoring: "Authoring",
  verifying: "Verifying",
  reviewing: "Reviewing",
  infrastructure_failed: "Failed",
  rejected: "Rejected",
  accepted: "Verified",
};
export function BatchTasks({ status, fullName }: { status: BatchStatus; fullName: string }) {
  return (
    <section className="mt-8">
      <SectionHeader title="Tasks">
        <Link
          to={`/repos/${fullName}`}
          className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          View Dataset
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </SectionHeader>
      {status.tasks?.length ? (
        <ul
          className="divide-y divide-border border border-border bg-card"
          aria-label="Batch Tasks"
        >
          {status.tasks.map((task) => {
            const interrupted =
              batchIsTerminal(status.phase) &&
              !["accepted", "rejected", "infrastructure_failed"].includes(task.status);
            return (
              <li key={task.candidateId}>
                <Link
                  to={`/repos/${fullName}/tasks/${encodeURIComponent(status.runId)}/${encodeURIComponent(task.taskId)}`}
                  className="grid items-center gap-3 px-4 py-4 hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_5rem_10rem]"
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
                  <span className="flex flex-wrap items-center gap-4 md:contents">
                    <DifficultyStamp difficulty={task.difficulty} />
                    <span
                      className={
                        status.activity?.[task.candidateId] === "running"
                          ? "text-xs text-brand"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {status.activity?.[task.candidateId] === "running"
                        ? "Running · "
                        : status.activity?.[task.candidateId] === "queued"
                          ? "Queued · "
                          : ""}
                      {interrupted ? "Stopped" : taskLabels[task.status]}
                      {task.round !== undefined ? ` · Round ${task.round}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          className="min-h-28 border-solid"
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
