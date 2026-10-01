import { Asterisk, ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import type { Configuration, Outcome, TaskResult } from "./results-model";
import { configurationColor, configurationDetail, outcomeLabels } from "./results-presentation";

/** How a glyph is drawn: filled, a ring, half filled, or a ring around a dot. */
type Fill = "full" | "none" | "half" | "dot";

/**
 * One state's glyph. Every task state has its own pair of color and fill, so no two look alike:
 * filled once finished, a ring while under way, a ring around a dot for a task not run yet.
 */
function Glyph({ tone, fill }: { tone: string; fill: Fill }) {
  // Drawn in SVG on a 10px grid, so the ring, the half and the dot all sit exactly on center
  // rather than on whichever half pixel a 1.5px border leaves them.
  return (
    <svg
      data-circle
      viewBox="0 0 10 10"
      className={cn("size-2.5 shrink-0", tone)}
      aria-hidden="true"
    >
      <circle
        cx="5"
        cy="5"
        r="4.25"
        fill={fill === "full" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {fill === "half" && <path d="M5 0.75 A4.25 4.25 0 0 0 5 9.25 Z" fill="currentColor" />}
      {fill === "dot" && <circle cx="5" cy="5" r="1.5" fill="currentColor" />}
    </svg>
  );
}

/**
 * Status circles. For a task: green when it passed, orange when the model didn't solve it, red
 * when it errored. For a batch or a configuration: green while nothing has errored, red once
 * something has, grey when cancelled or not started; a model failing some tasks is expected.
 */
function Circle({ label, tone, filled }: { label?: string; tone: string; filled: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium whitespace-nowrap">
      <Glyph tone={tone} fill={filled ? "full" : "none"} />
      {label}
    </span>
  );
}

/**
 * Red is for something that went wrong in running the task; orange for a model that ran but
 * didn't solve it. Grey and blue pair the states not run yet with Queued and Running.
 */
const outcomeGlyphs: Record<Outcome, { tone: string; fill: Fill }> = {
  passed: { tone: "text-success", fill: "full" },
  failed: { tone: "text-warning", fill: "full" },
  error: { tone: "text-destructive", fill: "full" },
  unscored: { tone: "text-foreground", fill: "half" },
  running: { tone: "text-check", fill: "none" },
  queued: { tone: "text-muted-foreground", fill: "none" },
  cancelled: { tone: "text-muted-foreground", fill: "full" },
  unrun: { tone: "text-muted-foreground", fill: "dot" },
  added: { tone: "text-check", fill: "dot" },
};

/** A task's result as a glyph, with its name unless `bare`, where the filter above names it. */
export function OutcomeCircle({ outcome, bare = false }: { outcome: Outcome; bare?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium whitespace-nowrap">
      <Glyph {...outcomeGlyphs[outcome]} />
      {!bare && outcomeLabels[outcome]}
    </span>
  );
}

/** States other than passed and failed, in the order the Done column's details list them. */
const otherStates: readonly Outcome[] = [
  "error",
  "unscored",
  "running",
  "queued",
  "cancelled",
  "unrun",
  "added",
];

/**
 * Beside a Done count, an asterisk when some tasks are in a state other than passed or failed:
 * hovering it lists them, each with its glyph and how many, in a card to its right. It takes the same width in every
 * row, icon or none, so the counts beside it line up.
 */
export function StateDetails({
  counts,
  finished,
  total,
}: {
  counts: Readonly<Partial<Record<Outcome, number>>>;
  finished: number;
  total: number;
}) {
  const present = otherStates.filter((outcome) => (counts[outcome] ?? 0) > 0);
  if (!present.length) return <span className="w-4 shrink-0" aria-hidden="true" />;
  const label = `${finished} of ${total} finished: ${present
    .map((outcome) => `${counts[outcome]} ${outcomeLabels[outcome]}`)
    .join(", ")}`;
  return (
    <InfoTooltip
      label={label}
      side="right"
      contentClassName="border border-border bg-card text-foreground"
      content={
        <span className="block font-mono">
          <span className="mb-1 block font-sans font-semibold">
            {finished} of {total} finished
          </span>
          {present.map((outcome) => (
            <span key={outcome} className="flex items-center gap-2">
              <Glyph {...outcomeGlyphs[outcome]} />
              <span className="w-6 text-right tabular-nums">{counts[outcome]}</span>
              {outcomeLabels[outcome]}
            </span>
          ))}
        </span>
      }
    >
      {/* A quiet footnote mark: there's more to this count. */}
      <button
        type="button"
        aria-label={label}
        // A badge in the theme's accent, gold in light and blue in dark, so it shows on either; the
        // mark takes the accent's own shade in light, which the deeper one overpowered.
        className="grid size-4 shrink-0 cursor-help place-items-center self-center rounded-[3px] border border-brand/60 bg-brand/10 text-brand hover:border-brand hover:bg-brand/20 [:root[data-theme=dark]_&]:text-brand-foreground"
      >
        <Asterisk className="size-2.5" strokeWidth={3} aria-hidden="true" />
      </button>
    </InfoTooltip>
  );
}

export type RunState =
  | "done"
  | "done-errors"
  | "running"
  | "running-errors"
  | "queued"
  | "cancelled";

const runStates: Record<RunState, { label: string; tone: string; filled: boolean }> = {
  done: { label: "Done", tone: "text-success", filled: true },
  "done-errors": { label: "Done with Errors", tone: "text-destructive", filled: true },
  running: { label: "Running", tone: "text-success", filled: false },
  "running-errors": { label: "Running with Errors", tone: "text-destructive", filled: false },
  queued: { label: "Queued", tone: "text-muted-foreground", filled: false },
  cancelled: { label: "Cancelled", tone: "text-muted-foreground", filled: true },
};

/**
 * The state of some results together: a batch's, or a configuration's latest. Only errors count
 * against it; models are expected to fail some tasks.
 */
export function runStateOf(results: readonly TaskResult[]): RunState {
  const has = (outcome: Outcome) => results.some((result) => result.outcome === outcome);
  const started =
    results.some((result) => result.outcome !== "queued") ||
    results.some((result) => result.run.status === "running");
  const errors = has("error");
  if (!has("running") && !has("queued")) {
    return has("cancelled") ? "cancelled" : errors ? "done-errors" : "done";
  }
  if (!started) return "queued";
  return errors ? "running-errors" : "running";
}

export function RunStateCircle({ state }: { state: RunState }) {
  return <Circle {...runStates[state]} />;
}

export function ResultsStatus({ results }: { results: readonly TaskResult[] }) {
  return <RunStateCircle state={runStateOf(results)} />;
}

/** A sortable heading's mark: both chevrons until it sorts, then the one it sorts by. */
export function SortIcon({ order }: { order: "ascending" | "descending" | undefined }) {
  const Icon =
    order === "ascending" ? ChevronUp : order === "descending" ? ChevronDown : ChevronsUpDown;
  return (
    <Icon className={cn("inline size-3 align-[-2px]", !order && "opacity-50")} aria-hidden="true" />
  );
}

/** The vendor's color, the model, and its reasoning, harness and the routes its runs took. */
export function ConfigurationName({ configuration }: { configuration: Configuration }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="size-2 shrink-0"
        style={{ background: configurationColor(configuration) }}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block truncate font-semibold">{configuration.label}</span>
        <span
          className="block truncate font-mono text-xs font-normal text-muted-foreground"
          title={configurationDetail(configuration)}
        >
          {configurationDetail(configuration)}
        </span>
      </span>
    </span>
  );
}

/**
 * A number column's "—" for no value, centered where the column's numbers usually sit rather
 * than flush right: `width` is their usual length in characters.
 */
export function NoValue({ width }: { width: number }) {
  return (
    <span className="inline-block text-center" style={{ width: `${width}ch` }}>
      —
    </span>
  );
}
