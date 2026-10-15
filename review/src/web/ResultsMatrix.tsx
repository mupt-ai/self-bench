import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Pass-rate shades in the text color, from a faint tint where every attempt failed to strong where
 * every attempt passed. Lightness, not hue, tells them apart, so they read the same with red-green
 * color blindness. Five steps at most, so neighbors stay distinguishable.
 */
const SHADES = [
  "bg-foreground/10",
  "bg-foreground/25",
  "bg-foreground/40",
  "bg-foreground/55",
  "bg-foreground/70",
  "bg-foreground/80",
] as const;

/** The shade for `passed` of `scored` attempts: the ends only when all failed or all passed. */
export const passShade = (passed: number, scored: number) =>
  passed >= scored ? SHADES[5] : passed <= 0 ? SHADES[0] : SHADES[Math.ceil((passed / scored) * 4)];

/** A single result's mark: strong where it passed, a faint tint where it failed. */
export const resultMark = (passed: boolean) => passShade(passed ? 1 : 0, 1);

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
/** An errored attempt's box: as dark as a pass, crossed so it can't be read as one. */
const ERRORED =
  "flex items-center justify-center bg-foreground/80 font-mono leading-none text-background";

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
  /** Draws a box, given its classes, label and content; a plain image by default. */
  /**
   * A task's column heading, given its classes and content: a tick at 45° over the column that
   * names the task, carrying on from the tick, while the column is pointed at. No heading row without it.
   */
  renderHead?(args: { task: ResultsMatrixTask; className: string; children: ReactNode }): ReactNode;
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
  // Where the pointed column's tick ends, on screen. Its name is drawn from there over the page, so
  // the ticks stay a tick high instead of the name's height.
  const wrapper = useRef<HTMLDivElement>(null);
  const ticks = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!pointed) return setAnchor(null);
    const measure = () => {
      const head = wrapper.current
        ?.querySelector(`[data-head="${CSS.escape(pointed)}"]`)
        ?.getBoundingClientRect();
      // The tick leans 45° from the strip's foot, 12px long: its end is ~8.5px across and up.
      setAnchor(head ? { x: head.left + head.width / 2 + 8.5, y: head.bottom - 8.5 } : null);
    };
    measure();
    // Scrolling the grid or the page moves the tick, so the name follows it.
    window.addEventListener("scroll", measure, true);
    return () => window.removeEventListener("scroll", measure, true);
  }, [pointed]);
  const pointedTask = pointed ? tasks?.find((task) => task.id === pointed) : undefined;

  const legend = (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {repeated ? (
        <span className="flex items-center gap-1.5">
          All Failed
          <span aria-hidden="true" className="flex gap-px">
            {SHADES.map((shade) => (
              <span key={shade} className={`size-2.5 ${shade}`} />
            ))}
          </span>
          All Passed
        </span>
      ) : (
        <>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2.5 ${resultMark(true)}`} />
            Passed
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2.5 ${resultMark(false)}`} />
            Failed
          </span>
        </>
      )}
      {errored && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-2.5 text-[9px] ${ERRORED}`}>
            ×
          </span>
          Errored
        </span>
      )}
      {neverRan && (
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="font-mono">
            ×
          </span>
          Never Ran
        </span>
      )}
    </p>
  );

  return (
    <section className={`flex min-w-0 flex-col ${titled ? "gap-1" : "gap-2"}`} aria-label={heading}>
      {titled && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-medium">{heading}</h2>
          {legend}
        </div>
      )}
      <div
        ref={wrapper}
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
          // Over the panel, kept in step with its scroll; the same transparent edge as the panel's
          // border keeps each tick over its column.
          <div ref={ticks} className="overflow-hidden border-x-[1.5px] border-transparent">
            <div className="flex w-max min-w-full">
              <div className="sticky left-0 z-[1] w-60 shrink-0 bg-background compact:w-32" />
              <div
                className={`grid min-w-0 flex-1 gap-0.5 ${boxes}`}
                style={{ gridTemplateColumns: columns }}
              >
                {tasks.map((task) => {
                  const shown = pointed === task.id;
                  return (
                    <div
                      key={task.id}
                      data-task={task.id}
                      data-head={task.id}
                      className="relative h-4"
                    >
                      {renderHead({
                        task,
                        className:
                          "absolute inset-0 flex items-end justify-center outline-offset-1 focus-visible:outline-2 focus-visible:outline-foreground",
                        children: (
                          <span
                            aria-hidden="true"
                            className={`h-3 w-[1.5px] origin-bottom rotate-45 ${shown ? "bg-foreground" : "bg-foreground/25"}`}
                          />
                        ),
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {pointedTask &&
          anchor &&
          createPortal(
            <span
              aria-hidden="true"
              className="pointer-events-none fixed z-50 block max-w-12 origin-bottom-left -translate-y-full -rotate-45 truncate bg-background px-0.5 font-mono text-[10px] leading-3 text-foreground"
              style={{ left: anchor.x, top: anchor.y }}
            >
              {pointedTask.head ?? pointedTask.label ?? pointedTask.id}
            </span>,
            document.body,
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
