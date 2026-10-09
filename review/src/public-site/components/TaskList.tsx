import { type RefObject, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { PublicRelease, PublicTask } from "../contract";
import { revealGroup } from "../effects/marks";
import { PANEL } from "../frame";
import { canHover } from "../mobile/device";
import { useSource } from "../source-context";

/** The task viewer, fetched on first use: neither the page nor its first paint needs it. */
export const loadTaskViewer = () => import("../pages/TaskViewer");

/** Tasks shown before "Show All". */
const FIRST = 8;
/** How far below the screen the list starts loading, so it is in by the time it is reached. */
const AHEAD = "800px";
/** How long a mouse rests on a task before its files load: passing over one loads nothing. */
const HOVER_MS = 80;

/** Navigation state of a task opened from the list: closing the viewer goes back to the list. */
export interface OpenedTask {
  fromList: true;
}

/** "Easy", "Medium", or "Hard". */
export const difficultyLabel = (task: Pick<PublicTask, "difficulty">) =>
  task.difficulty.charAt(0).toUpperCase() + task.difficulty.slice(1);

/** Whether `element` is on screen or within `AHEAD` of it; true from then on. */
export function useNear(element: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (near || !target) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: `${AHEAD} 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, near]);
  return near;
}

/**
 * A release's tasks, read once `enabled` (the section is near the screen). They stay with their
 * release, so another release's page never shows them; `retry` asks again after a failure.
 */
export function useReleaseTasks(release: PublicRelease, enabled: boolean) {
  const source = useSource();
  const [read, setRead] = useState<{
    releaseId: string;
    tasks?: PublicTask[];
    failed?: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again after a failure
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const { releaseId } = release;
    source.getTasks(releaseId).then(
      (tasks) => live && setRead({ releaseId, tasks: tasks ?? [] }),
      () => live && setRead({ releaseId, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [enabled, release.releaseId, source, attempt]);
  const current = read?.releaseId === release.releaseId ? read : undefined;
  return {
    tasks: current?.tasks,
    failed: current?.failed === true,
    retry: () => setAttempt((count) => count + 1),
  };
}

/**
 * A release's tasks, when its publisher published them: each opens in the task viewer, which
 * shows its files and offers it as a download. Nothing is read until the list nears the screen,
 * and a task's files are read as it is pointed at, pressed, or focused, before it is opened.
 */
export function TaskList({ release }: { release: PublicRelease }) {
  const source = useSource();
  const section = useRef<HTMLElement>(null);
  const { tasks, failed, retry } = useReleaseTasks(release, useNear(section));
  const [all, setAll] = useState(false);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);

  const shown = tasks && !all ? tasks.slice(0, FIRST) : tasks;
  const readAhead = (task: PublicTask) => {
    void loadTaskViewer();
    void source.getTaskFiles(release.releaseId, task.id).catch(() => undefined);
  };
  return (
    <section ref={section} className="flex flex-col gap-3" data-morph="tasks" {...revealGroup}>
      <h2 className="text-sm font-medium">Tasks</h2>
      {failed ? (
        <p className={`flex flex-wrap items-center gap-3 px-3 py-3 text-sm ${PANEL}`}>
          <span className="text-muted-foreground">The tasks didn't load.</span>
          <button
            type="button"
            onClick={retry}
            className="hit relative font-medium underline underline-offset-4"
          >
            Try Again
          </button>
        </p>
      ) : (
        <ul className={`divide-y divide-border ${PANEL}`} aria-busy={!tasks}>
          {shown
            ? shown.map((task) => (
                <li key={task.id}>
                  <Link
                    to={{ search: `?task=${encodeURIComponent(task.id)}` }}
                    state={{ fromList: true } satisfies OpenedTask}
                    preventScrollReset
                    onPointerEnter={(event) => {
                      if (event.pointerType !== "mouse" || !canHover()) return;
                      clearTimeout(hover.current);
                      hover.current = setTimeout(() => readAhead(task), HOVER_MS);
                    }}
                    onPointerLeave={() => clearTimeout(hover.current)}
                    onPointerDown={() => readAhead(task)}
                    onFocus={() => readAhead(task)}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-muted touch:py-3"
                  >
                    <span className="min-w-0 font-mono font-medium wrap-anywhere">{task.id}</span>
                    <span className="text-xs text-muted-foreground">{difficultyLabel(task)}</span>
                    {task.sourcePr !== undefined && (
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        PR #{task.sourcePr}
                      </span>
                    )}
                  </Link>
                </li>
              ))
            : Array.from({ length: Math.min(FIRST, release.tasks) }, (_, index) => (
                // Placeholders the size of a row, so the page does not jump when the list lands.
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                <li key={index} aria-hidden="true" className="px-3 py-2 touch:py-3">
                  <span className="block h-5 w-40 max-w-full animate-pulse bg-muted" />
                </li>
              ))}
        </ul>
      )}
      {tasks && !all && tasks.length > FIRST && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="hit relative self-start text-sm font-medium underline underline-offset-4"
        >
          Show All {tasks.length} Tasks
        </button>
      )}
    </section>
  );
}
