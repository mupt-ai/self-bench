import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FileButton, FileView } from "../components/TaskFileView";
import { difficultyLabel } from "../components/TaskList";
import type { PublicRelease, PublicTask, PublicTaskFiles } from "../contract";
import { useSource } from "../source-context";
import { firstFile } from "../task-files";
import "./task-viewer.css";

/**
 * One published task, over the page: its files down the side and the chosen one beside them,
 * with the task's download. Opened by the page's address (`?task=<id>`), so a link opens it, and
 * Back or Escape closes it. Previous and Next step through the release's tasks in place.
 */
export default function TaskViewer({
  release,
  taskId,
  onClose,
  onSwitch,
}: {
  release: PublicRelease;
  taskId: string;
  onClose(): void;
  /** Shows another task of the release in the viewer's place. */
  onSwitch(taskId: string): void;
}) {
  const source = useSource();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [tasks, setTasks] = useState<PublicTask[]>();
  const [read, setRead] = useState<{ taskId: string; files?: PublicTaskFiles; failed?: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<{ taskId: string; path: string }>();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    // Focus starts on Close, not on a file, so a keyboard reader hears the task first.
    close.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let live = true;
    source.getTasks(release.releaseId).then(
      (found) => live && setTasks(found ?? []),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [release.releaseId, source]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again after a failure
  useEffect(() => {
    let live = true;
    source.getTaskFiles(release.releaseId, taskId).then(
      (files) => live && setRead({ taskId, files, failed: !files }),
      () => live && setRead({ taskId, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [release.releaseId, taskId, source, attempt]);

  const index = tasks?.findIndex((task) => task.id === taskId) ?? -1;
  const task = index >= 0 ? tasks?.[index] : undefined;
  const previous = index > 0 ? tasks?.[index - 1] : undefined;
  const next = index >= 0 ? tasks?.[index + 1] : undefined;
  // The neighbours' files load while this task is read, so stepping to them is instant.
  useEffect(() => {
    for (const neighbour of [previous, next])
      if (neighbour)
        void source.getTaskFiles(release.releaseId, neighbour.id).catch(() => undefined);
  }, [previous, next, release.releaseId, source]);

  const current = read?.taskId === taskId ? read : undefined;
  const files = current?.files?.files ?? [];
  const path = chosen?.taskId === taskId ? chosen.path : (firstFile(files)?.path ?? files[0]?.path);
  const file = files.find((entry) => entry.path === path);
  const repository = release.repository.fullName;
  const prUrl =
    task?.sourceUrl ??
    (task?.sourcePr !== undefined
      ? `https://github.com/${repository}/pull/${task.sourcePr}`
      : undefined);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="task-title"
      // Escape closes through the address, like the Close button, so Back does not reopen it.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="task-viewer m-auto flex h-[min(100dvh-4rem,60rem)] max-h-none w-[min(100vw-4rem,90rem)] max-w-none flex-col border-[1.5px] border-(--panel-border) bg-background p-0 text-sm text-foreground backdrop:bg-black/40 compact:h-dvh compact:w-full compact:border-0"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="task-title" className="min-w-0 font-mono text-base font-medium wrap-anywhere">
            {taskId}
          </h2>
          {task && <span className="text-xs text-muted-foreground">{difficultyLabel(task)}</span>}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="hit relative font-mono text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              PR #{task?.sourcePr}
            </a>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <StepButton label="Previous Task" target={previous} onSwitch={onSwitch}>
            <ChevronLeft className="size-4" aria-hidden="true" />
          </StepButton>
          <StepButton label="Next Task" target={next} onSwitch={onSwitch}>
            <ChevronRight className="size-4" aria-hidden="true" />
          </StepButton>
          <a
            href={source.taskDownloadUrl(release.releaseId, taskId)}
            download={`${taskId}.tar.gz`}
            className="hit relative ml-2 inline-flex items-center gap-1.5 border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background"
          >
            <Download className="size-4" aria-hidden="true" />
            Download
          </a>
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
      {current?.failed ? (
        <p className="flex flex-wrap items-center gap-3 p-4">
          <span className="text-muted-foreground">
            {tasks && !task ? "This release has no task by that name." : "The task didn't load."}
          </span>
          {(!tasks || task) && (
            <button
              type="button"
              onClick={() => setAttempt((count) => count + 1)}
              className="hit relative font-medium underline underline-offset-4"
            >
              Try Again
            </button>
          )}
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] md:grid-rows-1">
          <nav
            aria-label="Files"
            className="min-h-0 overflow-y-auto border-b border-border py-1 md:border-r md:border-b-0 compact:max-h-44"
          >
            {current ? (
              <ul>
                {files.map((entry) => (
                  <li key={entry.path}>
                    <FileButton
                      file={entry}
                      chosen={entry.path === path}
                      onChoose={() => setChosen({ taskId, path: entry.path })}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-2 text-muted-foreground">Loading…</p>
            )}
          </nav>
          <section aria-label={file?.path ?? "File"} className="min-h-0 min-w-0 overflow-auto">
            {file && <FileView file={file} files={files} repository={repository} taskId={taskId} />}
          </section>
        </div>
      )}
      {/* The canary the task's files carry, beside them for anything that copies the page. */}
      {current?.files?.canary && (
        <p className="border-t border-border px-4 py-1.5 font-mono text-[11px] text-muted-foreground wrap-anywhere">
          {current.files.canary}
        </p>
      )}
    </dialog>
  );
}

function StepButton({
  label,
  target,
  onSwitch,
  children,
}: {
  label: string;
  target: PublicTask | undefined;
  onSwitch(taskId: string): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!target}
      onClick={() => target && onSwitch(target.id)}
      className="hit relative inline-flex size-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
