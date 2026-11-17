import { CHART_VIEWS, type ChartView } from "../chart-views";

/** The results chart's views, one pressed at a time. */
export function ChartViewChips({
  view,
  onChange,
}: {
  view: ChartView;
  onChange: (view: ChartView) => void;
}) {
  return (
    <fieldset aria-label="Chart View" className="flex flex-wrap gap-1.5">
      {CHART_VIEWS.map((entry) => {
        const pressed = entry.id === view;
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(entry.id)}
            className={`hit relative inline-flex items-center border px-2 py-0.5 text-xs transition-colors ${
              pressed
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {entry.label}
          </button>
        );
      })}
    </fieldset>
  );
}
