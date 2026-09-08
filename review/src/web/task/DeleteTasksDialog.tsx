import React from "react";
import type { TaskItem } from "../api";

export function DeleteTasksDialog({
  tasks,
  busy,
  onCancel,
  onConfirm,
}: {
  tasks: readonly TaskItem[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const cancel = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  React.useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      queueMicrotask(() => {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
          previousFocus.focus();
      });
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-md border border-line-strong bg-bg p-5 text-ink shadow-xl backdrop:bg-black/60"
    >
      <h2 id={titleId} className="font-sans text-lg font-semibold">
        {tasks.length === 1 ? "Delete Task?" : `Delete ${tasks.length} Tasks?`}
      </h2>
      <p id={descriptionId} className="mt-3 break-words text-base text-muted">
        {tasks.length === 1
          ? `Remove “${tasks[0]?.taskId}” from this dataset?`
          : `Remove these ${tasks.length} selected tasks from this dataset?`}{" "}
        They will stay removed after sync. Historical results and artifacts are kept.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          ref={cancel}
          type="button"
          className="inline-flex h-9 items-center border border-line-strong px-4 text-sm font-bold disabled:opacity-40"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center border border-danger px-4 text-sm font-bold text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Deleting…" : tasks.length === 1 ? "Delete Task" : "Delete Tasks"}
        </button>
      </div>
    </dialog>
  );
}
