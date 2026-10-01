import type { ReactNode } from "react";
import { cn } from "../primitives/cn";
import { OutcomeCircle, type RunState, RunStateCircle } from "./ResultsMarks";
import type { Outcome } from "./results-model";

/** The state toggles above the table and over each group's tasks. */

/** Result states in the order filters list them, and the ones a filter starts with on. */
export const resultStates: readonly Outcome[] = [
  "passed",
  "failed",
  "error",
  "unscored",
  "running",
  "queued",
  "cancelled",
];

/**
 * Small toggles, one per state, each its circle, name and count; a state with none is disabled.
 * The states that are on are the ones shown.
 */
function StateFilter<Key extends string>({
  legend,
  states,
  selected,
  onToggle,
}: {
  legend: string;
  states: { key: Key; circle: ReactNode; count: number }[];
  selected: ReadonlySet<Key>;
  onToggle(key: Key): void;
}) {
  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-1.5">
      <legend className="sr-only">{legend}</legend>
      {states.map(({ key, circle, count }) => {
        const on = selected.has(key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on && count > 0}
            disabled={!count}
            className={cn(
              "inline-flex items-center gap-1.5 border px-2 py-0.5 hover:bg-foreground/[0.06] disabled:opacity-40 disabled:hover:bg-transparent",
              // A state with none is faded and never looks chosen, whatever its setting.
              on && count ? "border-foreground/60 bg-foreground/[0.08]" : "border-border",
            )}
            onClick={() => onToggle(key)}
          >
            {circle}
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{count}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

export function OutcomeFilter({
  outcomes,
  selected,
  coverage = false,
  onToggle,
}: {
  outcomes: readonly Outcome[];
  selected: ReadonlySet<Outcome>;
  /** Whether to offer Left Out and Added Later, for tasks a configuration has no result for. */
  coverage?: boolean;
  onToggle(outcome: Outcome): void;
}) {
  return (
    <StateFilter
      legend="Filter Results"
      states={[...resultStates, ...(coverage ? (["unrun", "added"] as const) : [])].map(
        (outcome) => ({
          key: outcome,
          circle: <OutcomeCircle outcome={outcome} />,
          count: outcomes.filter((entry) => entry === outcome).length,
        }),
      )}
      selected={selected}
      onToggle={onToggle}
    />
  );
}

/** A selection with one state switched on or off. */
export function toggledOutcome(selected: ReadonlySet<Outcome>, outcome: Outcome) {
  const next = new Set(selected);
  if (!next.delete(outcome)) next.add(outcome);
  return next;
}

export function RunStateFilter({
  states,
  selected,
  onToggle,
}: {
  states: readonly RunState[];
  selected: ReadonlySet<RunState>;
  onToggle(state: RunState): void;
}) {
  const order: RunState[] = [
    "done",
    "done-errors",
    "running",
    "running-errors",
    "queued",
    "cancelled",
  ];
  return (
    <StateFilter
      legend="Filter Configurations"
      states={order.map((state) => ({
        key: state,
        circle: <RunStateCircle state={state} />,
        count: states.filter((entry) => entry === state).length,
      }))}
      selected={selected}
      onToggle={onToggle}
    />
  );
}
