import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TrialDetails } from "../../web/evaluation/TrialDetails";
import { TrialGrading } from "../components/TrialGrading";
import type { PublicRelease, PublicTrial } from "../contract";
import { dollars, harnessLabel, reasoningLabel, settingLabel } from "../format";
import { useSource } from "../source-context";
import { onBackdrop } from "./backdrop";

/**
 * One setting's attempt at one task, over the page: whether it passed, how the verifier graded
 * it, what it cost, and its transcript, drawn by the same component as the app's trial dialog.
 * Opened by the page's address (`?trace=<task>&setting=<id>`), so a link opens it, and Back,
 * Escape, or a click on the page around it closes it.
 */
export default function TraceViewer({
  release,
  taskId,
  settingId,
  onClose,
  onOpenTask,
}: {
  release: PublicRelease;
  taskId: string;
  settingId: string;
  onClose(): void;
  /** Shows the task itself, its files, in the viewer's place. */
  onOpenTask(): void;
}) {
  const source = useSource();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Whether the press now under way began on the page around the viewer.
  const pressedOutside = useRef(false);
  const [read, setRead] = useState<{ key: string; trial?: PublicTrial; failed?: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const key = `${taskId}\n${settingId}`;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    close.current?.focus();
    return () => element?.close();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again after a failure
  useEffect(() => {
    let live = true;
    source.getTrial(release.releaseId, taskId, settingId).then(
      (trial) => live && setRead({ key, ...(trial ? { trial } : {}) }),
      () => live && setRead({ key, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [release.releaseId, taskId, settingId, key, source, attempt]);

  const current = read?.key === key ? read : undefined;
  const trial = current?.trial;
  const setting = release.settings.find((entry) => entry.id === settingId);
  const minutes =
    trial?.startedAt && trial.finishedAt
      ? (Date.parse(trial.finishedAt) - Date.parse(trial.startedAt)) / 60_000
      : undefined;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard's way to close it (onCancel)
    <dialog
      ref={dialog}
      aria-labelledby="trace-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressedOutside.current = onBackdrop(event);
      }}
      onClick={(event) => {
        if (pressedOutside.current && onBackdrop(event)) onClose();
        pressedOutside.current = false;
      }}
      className="m-auto flex h-[min(100dvh-4rem,60rem)] max-h-none w-[min(100vw-4rem,72rem)] max-w-none flex-col border-[1.5px] border-(--panel-border) bg-background p-0 text-sm text-foreground backdrop:bg-black/40 compact:h-dvh compact:w-full compact:border-0"
    >
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="trace-title" className="min-w-0 font-mono text-base font-medium wrap-anywhere">
            {taskId}
          </h2>
          {setting && (
            <p className="text-xs text-muted-foreground">
              {[
                settingLabel(setting, release.settings),
                harnessLabel(setting),
                reasoningLabel(setting),
              ].join(" · ")}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenTask}
            className="hit relative px-2 py-1.5 text-sm hover:bg-muted"
          >
            View Task
          </button>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            ref={close}
            onClick={onClose}
            className="hit relative ml-1 inline-flex size-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>
      {trial && (
        <p className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border px-4 py-2">
          <span className="flex items-center gap-1.5 font-medium">
            <span
              aria-hidden="true"
              className={`size-2.5 ${trial.passed ? "bg-(--ok)" : "bg-(--bad)"}`}
            />
            {trial.passed ? "Passed" : "Failed"}
          </span>
          {minutes !== undefined && (
            <span className="font-mono text-xs text-muted-foreground">
              {Math.max(1, Math.round(minutes))} min
            </span>
          )}
          {trial.apiCostUsd !== undefined && (
            <span className="font-mono text-xs text-muted-foreground">
              {dollars(trial.apiCostUsd)}
            </span>
          )}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {current?.failed ? (
          <p className="flex flex-wrap items-center gap-3">
            <span className="text-muted-foreground">The transcript didn't load.</span>
            <button
              type="button"
              onClick={() => setAttempt((count) => count + 1)}
              className="hit relative font-medium underline underline-offset-4"
            >
              Try Again
            </button>
          </p>
        ) : current && !trial ? (
          <p className="text-muted-foreground">
            This release has no transcript for that setting on that task.
          </p>
        ) : trial ? (
          <>
            <TrialGrading trial={trial} />
            <TrialDetails trial={trial} agentMinutes={trial.agentMinutes} />
          </>
        ) : (
          <p className="text-muted-foreground">Loading…</p>
        )}
      </div>
    </dialog>
  );
}
