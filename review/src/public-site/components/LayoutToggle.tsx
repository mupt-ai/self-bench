import { Columns2, Rows2 } from "lucide-react";
import { sharedPreferences } from "../preferences";

/** How a repository page places its chart and settings table: one above the other, or side by side. */
export type ResultsLayout = "stacked" | "side";

const KEY = "selfbench-results-layout";

/** The layout this browser last chose, kept like the theme (see preferences.ts); stacked at first. */
export function readResultsLayout(): ResultsLayout {
  return sharedPreferences()?.getItem(KEY) === "side" ? "side" : "stacked";
}

export function rememberResultsLayout(layout: ResultsLayout): void {
  sharedPreferences()?.setItem(KEY, layout);
}

/**
 * The page's layout switch: stacked or side by side. Side by side needs a wide window (90rem,
 * where the table still fits as a table beside the chart), so the switch shows only there.
 */
export function LayoutToggle({
  layout,
  onChange,
}: {
  layout: ResultsLayout;
  onChange: (layout: ResultsLayout) => void;
}) {
  const option = (value: ResultsLayout, label: string, Icon: typeof Rows2) => (
    <button
      type="button"
      aria-pressed={layout === value}
      aria-label={label}
      title={label}
      onClick={() => onChange(value)}
      className={`hit relative inline-flex size-7 cursor-pointer items-center justify-center transition-colors hover:text-foreground ${
        layout === value ? "bg-muted text-foreground" : "text-muted-foreground"
      }`}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
  return (
    <fieldset
      aria-label="Results Layout"
      className="hidden min-w-0 items-center border border-(--panel-border) min-[90rem]:inline-flex"
    >
      {option("stacked", "Stacked Layout", Rows2)}
      {option("side", "Side-by-Side Layout", Columns2)}
    </fieldset>
  );
}
