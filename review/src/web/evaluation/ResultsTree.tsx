import { ChevronRight } from "lucide-react";
import { cn } from "../primitives/cn";

/**
 * The Results table's tree: a configuration's chevron sits 20px into its row, and each of its
 * batches has an elbow from under that chevron into its own, so they read as its children.
 */
export const CONFIGURATION_CHEVRON = 20;
export const BATCH_CHEVRON = 36;
/** Where a batch's text starts, past its chevron. */
export const BATCH_INDENT = "pl-[56px]!";
/** Where a task's text starts: past its result circle, under the batch's chevron. */
export const TASK_INDENT = "pl-[56px]!";

/**
 * A row's open-and-close control: everything left of the chevron, the chevron included, so the
 * whole gutter is a target.
 */
export function Toggle({
  open,
  chevron,
  label,
  title,
  onToggle,
}: {
  open: boolean;
  /** The chevron's center, from the row's left edge. */
  chevron: number;
  label: string;
  title: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="absolute inset-y-0 left-0 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
      style={{ width: chevron + 12 }}
      aria-expanded={open}
      aria-label={label}
      title={title}
      onClick={onToggle}
    >
      <ChevronRight
        className={cn(
          "absolute top-1/2 size-3.5 -translate-y-1/2 transition-transform",
          open && "rotate-90",
        )}
        style={{ left: chevron - 7 }}
        aria-hidden="true"
      />
    </button>
  );
}

/**
 * A batch's elbow: down from its row's top padding, under the configuration's chevron, then round
 * into the batch's chevron. One stroke of one weight, so the corner is no darker than the rest.
 */
/** How far below its row's top edge an elbow starts: the row's own padding. */
const ELBOW_INSET = 8;

export function Elbow() {
  return (
    <span
      className="pointer-events-none absolute rounded-bl-[6px] border-b-[1.5px] border-l-[1.5px] border-foreground/40"
      style={{
        left: CONFIGURATION_CHEVRON - 0.75,
        width: BATCH_CHEVRON - CONFIGURATION_CHEVRON - 6,
        // From the row's top padding, not its edge, down to the chevron's middle.
        top: ELBOW_INSET,
        height: `calc(50% + 0.75px - ${ELBOW_INSET}px)`,
      }}
      aria-hidden="true"
    />
  );
}
