import { useRef } from "react";
import { Link } from "react-router";
import { ResultsMatrix, type ResultsMatrixRow } from "../../web/ResultsMatrix";

export { resultMark } from "../../web/ResultsMatrix";

import type { PublicRelease } from "../contract";
import { revealGroup } from "../effects/marks";
import { harnessLabel, reasoningLabel, settingLabel, vendorColor } from "../format";
import { resultsGrid } from "../results-grid";
import { useSource } from "../source-context";
import { type OpenedTask, useNear, useReleaseTasks } from "./TaskList";

/** The trace viewer, fetched on first use, as the task viewer is. */
export const loadTraceViewer = () => import("../pages/TraceViewer");

/** The address of one setting's trace on one task, over the repository page. */
const traceSearch = (taskId: string, settingId: string) =>
  `?trace=${encodeURIComponent(taskId)}&setting=${encodeURIComponent(settingId)}`;

/**
 * Every setting's result on every task of a release that published its trials: settings down the
 * side, tasks across, a strong box where it passed and a faint one where it did not. A box opens
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
  const { tasks, failed, retry } = useReleaseTasks(release, useNear(section));
  const grid = tasks && resultsGrid(release.settings, tasks);
  if (tasks && !grid) return null;

  const rows: ResultsMatrixRow[] = (grid?.settings ?? release.settings).map((setting) => ({
    id: setting.id,
    label: settingLabel(setting, release.settings),
    detail: `${harnessLabel(setting)} · ${reasoningLabel(setting)}`,
    color: vendorColor(setting),
    active: setting.id === activeId,
    ...(grid
      ? {
          metric: `${grid.tasks.filter((task) => task.passed[setting.id]).length}/${grid.tasks.length}`,
        }
      : {}),
  }));

  return (
    <section ref={section} className="flex min-w-0 flex-col gap-3" {...revealGroup}>
      {failed ? (
        <p className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm panel">
          <span className="text-muted-foreground">The results didn't load.</span>
          <button
            type="button"
            onClick={retry}
            className="hit relative font-medium underline underline-offset-4"
          >
            Try Again
          </button>
        </p>
      ) : (
        <ResultsMatrix
          rows={rows}
          tasks={grid?.tasks ?? null}
          placeholders={Math.min(release.tasks, 24)}
          cell={(settingId, taskId) => {
            const passed = grid?.tasks.find((task) => task.id === taskId)?.passed[settingId];
            return passed === undefined
              ? undefined
              : { passed: passed ? 1 : 0, failed: passed ? 0 : 1 };
          }}
          // A transcript is large and kept for the visit, so only a press reads one ahead; pointing
          // at or focusing a box only fetches the viewer itself.
          renderBox={({ rowId: settingId, task, className, label }) => (
            <Link
              to={{ search: traceSearch(task.id, settingId) }}
              state={{ fromList: true } satisfies OpenedTask}
              preventScrollReset
              aria-label={label}
              title={label}
              onPointerEnter={() => void loadTraceViewer()}
              onPointerDown={() => {
                void loadTraceViewer();
                void source.getTrial(release.releaseId, task.id, settingId).catch(() => undefined);
              }}
              onFocus={() => void loadTraceViewer()}
              className={className}
            />
          )}
        />
      )}
    </section>
  );
}
