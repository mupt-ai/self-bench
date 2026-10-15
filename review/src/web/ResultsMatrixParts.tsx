import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
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

/** An errored attempt's box: as dark as a pass, crossed so it can't be read as one. */
export const ERRORED =
  "flex items-center justify-center bg-foreground/80 font-mono leading-none text-background";

/** The marks the grid uses: a shade scale once any task has several attempts, else pass and fail. */
export function MatrixLegend({
  repeated,
  errored,
  neverRan,
}: {
  repeated: boolean;
  errored: boolean;
  neverRan: boolean;
}) {
  return (
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
}

interface HeadedTask {
  id: string;
  label?: string;
  head?: string;
}

/**
 * A 45° tick over each task's column, outside the grid's panel and kept in step with its scroll
 * (`scroller`); the pointed column's tick darkens and its name carries on from it over the page,
 * so the ticks stay a tick high instead of the name's height.
 */
export function TaskTicks<Task extends HeadedTask>({
  tasks,
  columns,
  boxes,
  pointed,
  scroller,
  renderHead,
}: {
  tasks: readonly Task[];
  columns: string;
  boxes: string;
  pointed: string | null;
  scroller: RefObject<HTMLDivElement | null>;
  renderHead(args: { task: Task; className: string; children: ReactNode }): ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!pointed) return setAnchor(null);
    const measure = () => {
      const head = strip.current
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
  const named = pointed ? tasks.find((task) => task.id === pointed) : undefined;
  return (
    <>
      {/* The same transparent edge as the panel's border keeps each tick over its column. */}
      <div ref={scroller} className="overflow-hidden border-x-[1.5px] border-transparent">
        <div ref={strip} className="flex w-max min-w-full">
          <div className="sticky left-0 z-[1] w-60 shrink-0 bg-background compact:w-32" />
          <div
            className={`grid min-w-0 flex-1 gap-0.5 ${boxes}`}
            style={{ gridTemplateColumns: columns }}
          >
            {tasks.map((task) => (
              <div key={task.id} data-task={task.id} data-head={task.id} className="relative h-4">
                {renderHead({
                  task,
                  className:
                    "absolute inset-0 flex items-end justify-center outline-offset-1 focus-visible:outline-2 focus-visible:outline-foreground",
                  children: (
                    <span
                      aria-hidden="true"
                      className={`h-3 w-[1.5px] origin-bottom rotate-45 ${
                        pointed === task.id ? "bg-foreground" : "bg-foreground/25"
                      }`}
                    />
                  ),
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {named &&
        anchor &&
        createPortal(
          <span
            aria-hidden="true"
            className="pointer-events-none fixed z-50 block max-w-12 origin-bottom-left -translate-y-full -rotate-45 truncate bg-background px-0.5 font-mono text-[10px] leading-3 text-foreground"
            style={{ left: anchor.x, top: anchor.y }}
          >
            {named.head ?? named.label ?? named.id}
          </span>,
          document.body,
        )}
    </>
  );
}
