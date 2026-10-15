import { type ReactNode, useRef, useState } from "react";
import { ERRORED, MatrixLegend, passShade, TaskTicks } from "./ResultsMatrixParts";

export { passShade, resultMark } from "./ResultsMatrixParts";

export interface ResultsMatrixTask {
  id: string;
  /** How labels name the task, when not by its id. */
  label?: string;
  /** The task's short name over its column, shown while its column is pointed at. */
  head?: string;
}

/** A row's attempts at one task. */
export interface ResultsMatrixCell {
  passed: number;
  failed: number;
  /** Attempts that errored, which neither passed nor failed. */
  errored?: number;
  /** Attempts with no score yet or ever: running, queued, cancelled, unscored. */
  other?: number;
}

export interface ResultsMatrixRow {
  id: string;
  label: string;
  detail: string;
  color: string;
  active?: boolean;
  metric?: ReactNode;
}

const cellSummary = ({ passed, failed, errored = 0, other = 0 }: ResultsMatrixCell) => {
  const scored = passed + failed;
  if (scored === 1 && !errored && !other) return passed ? "Passed" : "Failed";
  return [
    scored ? `${passed} of ${scored} Passed` : "",
    errored ? `${errored} Errored` : "",
    other ? `${other} Unscored` : "",
  ]
    .filter(Boolean)
    .join(", ");
};

const BOX = "h-5 touch:h-6";

/**
 * Every row's results on every task: rows down the side, tasks across, one box per pair shaded by
 * how many of its attempts passed. Shared by selfbench.dev and the app's Results page.
 */
export function ResultsMatrix({
  heading = "Results by Task",
  titled = true,
  rows,
  tasks,
  placeholders = 24,
  cell,
  empty = "blank",
  renderHead,
  renderBox,
}: {
  /**
   * The section's name, shown as its title with the legend beside it, unless `titled` is false,
   * which leaves the name to screen readers and puts the legend under the grid.
   */
  heading?: string;
  titled?: boolean;
  rows: readonly ResultsMatrixRow[];
  /** Null while the tasks load, drawn as `placeholders` pulsing boxes a row. */
  tasks: readonly ResultsMatrixTask[] | null;
  placeholders?: number;
  /** The row's attempts at the task, or nothing where it has none. */
  cell(rowId: string, taskId: string): ResultsMatrixCell | undefined;
  /** What a task the row has no attempt at shows: nothing, or a cross for "never ran". */
  empty?: "blank" | "cross";
  /** A task's tick over its column (TaskTicks), given its classes and mark; none without it. */
  renderHead?(args: { task: ResultsMatrixTask; className: string; children: ReactNode }): ReactNode;
  /** Draws a box, given its classes, label and content; a plain image by default. */
  renderBox?(args: {
    rowId: string;
    task: ResultsMatrixTask;
    cell: ResultsMatrixCell;
    className: string;
    label: string;
    children: ReactNode;
  }): ReactNode;
}) {
  const cells = tasks ? rows.flatMap((row) => tasks.map((task) => cell(row.id, task.id))) : [];
  const repeated = cells.some((entry) => entry && entry.passed + entry.failed > 1);
  // Only an attempt with no score at all shows the errored box; errors beside scored attempts are in its label.
  const errored = cells.some((entry) => entry?.errored && !(entry.passed + entry.failed));
  const neverRan = empty === "cross" && cells.some((entry) => !entry);

  const columns = `repeat(${tasks?.length ?? placeholders}, minmax(var(--box), 1fr))`;
  const boxes = "px-3 [--box:1rem] touch:[--box:1.5rem]";
  // The column pointed at or focused, anywhere from its heading down, which its heading names.
  const [pointed, setPointed] = useState<string | null>(null);
  const point = (event: { target: EventTarget }) =>
    setPointed(
      event.target instanceof Element
        ? (event.target.closest("[data-task]")?.getAttribute("data-task") ?? null)
        : null,
    );
  const ticks = useRef<HTMLDivElement>(null);
  const legend = <MatrixLegend repeated={repeated} errored={errored} neverRan={neverRan} />;

  return (
    <section className={`flex min-w-0 flex-col ${titled ? "gap-1" : "gap-2"}`} aria-label={heading}>
      {titled && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-medium">{heading}</h2>
          {legend}
        </div>
      )}
      <div
        className="flex min-w-0 flex-col"
        {...(renderHead
          ? {
              onPointerOver: point,
              onFocus: point,
              onPointerLeave: () => setPointed(null),
              onBlur: () => setPointed(null),
            }
          : {})}
      >
        {tasks && renderHead && (
          <TaskTicks
            tasks={tasks}
            columns={columns}
            boxes={boxes}
            pointed={pointed}
            scroller={ticks}
            renderHead={renderHead}
          />
        )}
        {/* One scroller for every row, so the boxes of a task stay in one column however far
            across it is scrolled; the names stay pinned at its left edge. */}
        <div
          className="overflow-x-auto panel"
          aria-busy={!tasks}
          onScroll={(event) => {
            if (ticks.current) ticks.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
        >
          <ul className="w-max min-w-full divide-y divide-border">
            {rows.map((row) => (
              <li
                key={row.id}
                className={`flex items-center ${row.active ? "bg-(--row-mark)" : ""}`}
              >
                {/* Above the boxes that scroll under it, and below the page's pinned bars (z-7). */}
                <div className="sticky left-0 z-[1] flex w-60 shrink-0 items-baseline gap-2 self-stretch border-r border-border bg-card px-3 py-2 text-sm compact:w-32 compact:px-2">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0"
                    style={{ background: row.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium wrap-anywhere">{row.label}</span>
                    <span className="block text-xs text-muted-foreground compact:text-[11px]">
                      {row.detail}
                    </span>
                  </span>
                  {row.metric !== undefined && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {row.metric}
                    </span>
                  )}
                </div>
                {/* The boxes share the row's width, down to a box each, past which the row scrolls.
                  On touch a box is 24px, the smallest target WCAG allows, short of the site's
                  44px: at 44px a phone showed only a few tasks per screen. */}
                <div
                  data-phone-ok="tap"
                  className={`grid min-w-0 flex-1 gap-0.5 py-2 ${boxes}`}
                  style={{ gridTemplateColumns: columns }}
                >
                  {tasks
                    ? tasks.map((task) => {
                        const attempts = cell(row.id, task.id);
                        if (!attempts) {
                          const never = `${row.label} never ran ${task.label ?? task.id}`;
                          return empty === "cross" ? (
                            <span
                              key={task.id}
                              data-task={task.id}
                              role="img"
                              aria-label={never}
                              title={never}
                              className={`flex items-center justify-center font-mono text-muted-foreground ${BOX}`}
                            >
                              ×
                            </span>
                          ) : (
                            <span key={task.id} className={BOX} />
                          );
                        }
                        const scored = attempts.passed + attempts.failed;
                        const className = scored
                          ? `block ${BOX} ${passShade(attempts.passed, scored)} ${
                              attempts.passed ? "hover:bg-foreground" : "hover:bg-foreground/25"
                            }`
                          : attempts.errored
                            ? `${BOX} ${ERRORED} text-xs hover:bg-foreground`
                            : `${BOX} flex items-center justify-center font-mono text-[10px] text-muted-foreground hover:bg-foreground/10`;
                        const label = `${row.label} on ${task.label ?? task.id}: ${cellSummary(attempts)}`;
                        const children = scored ? null : attempts.errored ? "×" : "·";
                        return (
                          <span key={task.id} data-task={task.id} className="contents">
                            {renderBox ? (
                              renderBox({
                                rowId: row.id,
                                task,
                                cell: attempts,
                                className: `outline-offset-1 transition-colors focus-visible:outline-2 focus-visible:outline-foreground ${className}`,
                                label,
                                children,
                              })
                            ) : (
                              <span
                                role="img"
                                aria-label={label}
                                title={label}
                                className={className}
                              >
                                {children}
                              </span>
                            )}
                          </span>
                        );
                      })
                    : // Placeholders the height of a row, so the page does not jump when it lands.
                      Array.from({ length: placeholders }, (_, index) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                          key={index}
                          aria-hidden="true"
                          className={`animate-pulse bg-muted ${BOX}`}
                        />
                      ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {!titled && legend}
    </section>
  );
}
