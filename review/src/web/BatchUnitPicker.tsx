import type { BatchUnit } from "./batch-api";
import { cn } from "./primitives/cn";
import { InfoTooltip } from "./primitives/tooltip";

const UNITS = [
  { id: "feature", label: "Features" },
  { id: "pull_request", label: "Pull Requests" },
] as const;

/** A row of mutually exclusive choices: the group is rounded, its segments are divided. */
const segmentedGroupStyles =
  "inline-flex overflow-hidden rounded-md border border-input divide-x divide-border text-[13px]";
const segmentStyles = (selected: boolean) =>
  cn(
    "px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    selected
      ? "bg-foreground/15 text-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );

/** What a batch builds tasks from: whole features (the default) or single PRs. */
export function BatchUnitPicker({
  unit,
  disabled,
  onChange,
}: {
  readonly unit: BatchUnit;
  readonly disabled: boolean;
  readonly onChange: (unit: BatchUnit) => void;
}) {
  return (
    <fieldset className="m-0 mb-8 min-w-0 border-0 p-0" aria-label="Build Tasks From">
      <legend className="mb-4 flex items-center gap-1.5 text-sm font-medium">
        Build Tasks From
        <InfoTooltip label="A feature task asks for a whole feature the repository built over several merged PRs, and grades it with end-to-end tests. A pull request task asks for one merged PR's change." />
      </legend>
      <div className={cn(segmentedGroupStyles, "grid w-full grid-cols-2")}>
        {UNITS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={unit === option.id}
            className={segmentStyles(unit === option.id)}
            disabled={disabled}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
