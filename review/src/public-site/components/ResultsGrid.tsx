import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { PublicRelease, PublicTask } from "../contract";
import { revealGroup } from "../effects/marks";
import { harnessLabel, reasoningLabel, settingLabel, vendorColor } from "../format";
import { PANEL } from "../frame";
import { canHover } from "../mobile/device";
import { resultsGrid } from "../results-grid";
import { useSource } from "../source-context";
import { type OpenedTask, useNear } from "./TaskList";

/** The trace viewer, fetched on first use, as the task viewer is. */
export const loadTraceViewer = () => import("../pages/TraceViewer");

/** How long a mouse rests on a box before its transcript loads: passing over one loads nothing. */
const HOVER_MS = 120;

/** The address of one setting's trace on one task, over the repository page. */
const traceSearch = (taskId: string, settingId: string) =>
  `?trace=${encodeURIComponent(taskId)}&setting=${encodeURIComponent(settingId)}`;

/**
 * Every setting's result on every task of a release that published its trials: settings down the
 * side, tasks across, a green box where it passed and a red one where it did not. A box opens
 * that attempt's transcript in the trace viewer. Read as the section nears the screen, from the
 * same task list the Tasks section reads.
 */
export function ResultsGrid({
  release,
  activeId = null,
}: {
  release: PublicRelease;
  /** The setting the chart or the settings table is pointing at, marked here too. */
  activeId?: string | null;
}) {
  const source = useSource();
  const section = useRef<HTMLElement>(null);
  const near = useNear(section);
  const [read, setRead] = useState<{ releaseId: string; tasks?: PublicTask[]; failed?: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again after a failure
  useEffect(() => {
    if (!near) return;
    let live = true;
    const { releaseId } = release;
    source.getTasks(releaseId).then(
      (tasks) => live && setRead({ releaseId, tasks: tasks ?? [] }),
      () => live && setRead({ releaseId, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [near, release.releaseId, source, attempt]);
  useEffect(() => () => clearTimeout(hover.current), []);

  const current = read?.releaseId === release.releaseId ? read : undefined;
  const grid = current?.tasks && resultsGrid(release.settings, current.tasks);
  // A release whose tasks carry no results has nothing to draw.
  if (current?.tasks && !grid) return null;
  const readAhead = (taskId: string, settingId: string) => {
    void loadTraceViewer();
    void source.getTrial(release.releaseId, taskId, settingId).catch(() => undefined);
  };
  return (
    <section ref={section} className="flex min-w-0 flex-col gap-3" {...revealGroup}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Results by Task</h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 bg-(--ok)" />
            Passed
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 bg-(--bad)" />
            Failed
          </span>
          <span>Select a box to read its transcript.</span>
        </p>
      </div>
      {current?.failed ? (
        <p className={`flex flex-wrap items-center gap-3 px-3 py-3 text-sm ${PANEL}`}>
          <span className="text-muted-foreground">The results didn't load.</span>
          <button
            type="button"
            onClick={() => setAttempt((count) => count + 1)}
            className="hit relative font-medium underline underline-offset-4"
          >
            Try Again
          </button>
        </p>
      ) : (
        // One scroller for every row, so the boxes of a task stay in one column however far
        // across it is scrolled; the names stay pinned at its left edge.
        <div className={`overflow-x-auto ${PANEL}`} aria-busy={!grid}>
          <ul className="w-max min-w-full divide-y divide-border">
            {(grid?.settings ?? release.settings).map((setting) => {
              const solved = grid?.tasks.filter((task) => task.passed[setting.id]).length;
              return (
                <li
                  key={setting.id}
                  className={`flex items-center ${setting.id === activeId ? "bg-(--row-mark)" : ""}`}
                >
                  {/* Above the boxes that scroll under it, and below the page's pinned bars (z-7). */}
                  <div className="sticky left-0 z-[1] flex w-60 shrink-0 items-baseline gap-2 self-stretch border-r border-border bg-card px-3 py-2 text-sm compact:w-40">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0"
                      style={{ background: vendorColor(setting) }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium wrap-anywhere">
                        {settingLabel(setting, release.settings)}
                      </span>
                      <span className="block text-xs text-muted-foreground compact:text-[11px]">
                        {harnessLabel(setting)} · {reasoningLabel(setting)}
                      </span>
                    </span>
                    {solved !== undefined && (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {solved}/{grid?.tasks.length}
                      </span>
                    )}
                  </div>
                  {/* The boxes share the row's width, down to a box each (44px on touch), past
                      which the row scrolls. */}
                  <div
                    className="grid min-w-0 flex-1 gap-0.5 px-3 py-2 [--box:1rem] touch:[--box:2.75rem]"
                    style={{
                      gridTemplateColumns: `repeat(${grid?.tasks.length ?? Math.min(release.tasks, 24)}, minmax(var(--box), 1fr))`,
                    }}
                  >
                    {grid
                      ? grid.tasks.map((task) => {
                          const passed = task.passed[setting.id];
                          if (passed === undefined)
                            return <span key={task.id} className="h-5 touch:h-11" />;
                          const label = `${settingLabel(setting, release.settings)} on ${task.id}: ${passed ? "Passed" : "Failed"}`;
                          return (
                            <Link
                              key={task.id}
                              to={{ search: traceSearch(task.id, setting.id) }}
                              state={{ fromList: true } satisfies OpenedTask}
                              preventScrollReset
                              aria-label={label}
                              title={label}
                              onPointerEnter={(event) => {
                                if (event.pointerType !== "mouse" || !canHover()) return;
                                clearTimeout(hover.current);
                                hover.current = setTimeout(
                                  () => readAhead(task.id, setting.id),
                                  HOVER_MS,
                                );
                              }}
                              onPointerLeave={() => clearTimeout(hover.current)}
                              onPointerDown={() => readAhead(task.id, setting.id)}
                              onFocus={() => readAhead(task.id, setting.id)}
                              className={`h-5 outline-offset-1 hover:outline-2 hover:outline-foreground focus-visible:outline-2 focus-visible:outline-foreground touch:h-11 ${
                                passed ? "bg-(--ok)" : "bg-(--bad)"
                              }`}
                            />
                          );
                        })
                      : // Placeholders the height of a row, so the page does not jump when it lands.
                        Array.from({ length: Math.min(release.tasks, 24) }, (_, index) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                            key={index}
                            aria-hidden="true"
                            className="h-5 animate-pulse bg-muted touch:h-11"
                          />
                        ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
