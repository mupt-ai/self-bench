import React from "react";
import { createPortal } from "react-dom";
import { deleteTask, type TaskItem } from "../api";
import { Button } from "../ui";
import { DeleteTasksDialog } from "./DeleteTasksDialog";
import { TaskList } from "./TaskList";
import { deleteSelectedTasks, taskKey } from "./task-deletion";

export function ReviewTaskList({
  org,
  fullName,
  visible,
  selectionScope,
  onDeleting,
  onDeleted,
  actionsTarget,
}: {
  actionsTarget?: HTMLElement | null;
  org: string;
  fullName: string;
  visible: TaskItem[];
  selectionScope: string;
  onDeleting: (deleting: boolean) => void;
  onDeleted: (deleted: ReadonlySet<string>) => void;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [deleting, setDeleting] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<TaskItem[] | null>(null);
  const lock = React.useRef(false);
  const [result, setResult] = React.useState<Awaited<
    ReturnType<typeof deleteSelectedTasks>
  > | null>(null);
  const [scope, setScope] = React.useState(selectionScope);
  if (scope !== selectionScope) {
    setScope(selectionScope);
    setSelected(new Set());
    setResult(null);
  }
  const selectable = visible.filter((task) => task.pipelineStatus !== "in_progress");
  const selectedTasks = selectable.filter((task) => selected.has(taskKey(task)));
  const selectedVisible = selectedTasks.length;
  const removeTasks = async (targets: TaskItem[]) => {
    if (targets.length === 0 || lock.current) return;
    lock.current = true;
    setDeleting(true);
    onDeleting(true);
    setResult(null);
    const outcome = await deleteSelectedTasks(targets, (task) =>
      deleteTask(org, fullName, task.runId, task.taskId),
    );
    onDeleted(outcome.deleted);
    setSelected(new Set(outcome.failures.map(({ task }) => taskKey(task))));
    setResult(outcome);
    setPendingDelete(null);
    lock.current = false;
    setDeleting(false);
    onDeleting(false);
  };

  const requestDelete = (targets: TaskItem[]) => {
    if (targets.length === 0 || lock.current) return;
    setPendingDelete(targets);
    onDeleting(true);
  };

  return (
    <>
      {actionsTarget &&
        selectedVisible > 0 &&
        createPortal(
          <>
            <span className="mr-auto text-xs tabular-nums text-muted-foreground">
              {selectedVisible} Selected
            </span>
            <Button
              variant="ghost"
              size="small"
              aria-label="Clear Selection"
              disabled={deleting}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
            <Button
              variant="destructive"
              size="small"
              title="Delete Selected Tasks"
              aria-busy={deleting}
              disabled={deleting}
              onClick={() => requestDelete(selectedTasks)}
            >
              {deleting ? "Deleting…" : "Delete Selected"}
            </Button>
          </>,
          actionsTarget,
        )}
      {pendingDelete && (
        <DeleteTasksDialog
          tasks={pendingDelete}
          busy={deleting}
          onCancel={() => {
            setPendingDelete(null);
            onDeleting(false);
          }}
          onConfirm={() => void removeTasks(pendingDelete)}
        />
      )}
      {result && (
        <div className="border-b border-border px-4 py-3 text-xs leading-5" role="status">
          <p>
            {result.deleted.size} task{result.deleted.size === 1 ? "" : "s"} deleted.
            {result.failures.length > 0 &&
              ` ${result.failures.length} could not be deleted and remain selected.`}
          </p>
          {result.failures.length > 0 && (
            <ul className="mt-2 list-inside list-disc break-words text-destructive">
              {result.failures.map(({ task, error }) => (
                <li key={taskKey(task)}>
                  {task.taskId} ({task.runId}): {error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {visible.length > 0 && (
        <TaskList
          fullName={fullName}
          tasks={visible}
          selected={selected}
          busy={deleting}
          onSelect={(task, checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(taskKey(task));
              else next.delete(taskKey(task));
              return next;
            })
          }
          onDelete={(task) => requestDelete([task])}
        />
      )}
    </>
  );
}
