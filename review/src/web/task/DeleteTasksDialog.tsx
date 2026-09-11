import React from "react";
import type { TaskItem } from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button } from "../ui";

export function DeleteTasksDialog({
  tasks,
  busy,
  onCancel,
  onConfirm,
}: {
  tasks: readonly TaskItem[];
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  return (
    <Dialog
      initialFocus={cancel}
      onDismiss={onCancel}
      busy={busy}
      size="small"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogHeader
        title={tasks.length === 1 ? "Delete Task?" : `Delete ${tasks.length} Tasks?`}
        titleId={titleId}
        onClose={onCancel}
        busy={busy}
      />
      <DialogBody>
        <p id={descriptionId} className="break-words text-sm leading-6 text-muted-foreground">
          {tasks.length === 1
            ? `Remove “${tasks[0]?.taskId}” from this dataset?`
            : `Remove these ${tasks.length} selected tasks from this dataset?`}{" "}
          They will stay removed after sync. Historical results and artifacts are kept.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button ref={cancel} disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={busy} onClick={onConfirm}>
          {busy ? "Deleting…" : tasks.length === 1 ? "Delete Task" : "Delete Tasks"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
