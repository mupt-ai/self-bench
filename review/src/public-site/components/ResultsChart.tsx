import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ChartView, viewAxes, viewLabel, viewPoint } from "../chart-views";
import type { PublicSetting } from "../contract";
import { harnessLabel, settingLabel, vendorPoint } from "../format";
import { ResultsPlot } from "./ResultsPlot";

/** The short name of a view's horizontal axis, under the plot where its label cannot sit. */
const ACROSS: Record<ChartView, string> = {
  "accuracy-cost": "Cost / Task",
  "accuracy-time": "Time / Task",
  "cost-time": "Time / Task",
};

/**
 * One point per setting, colored by model vendor, on the chosen view's axes (see chart-views.ts).
 * It tells the page which setting the pointer is on, and which settings a vendor chip highlights,
 * so the table below can mark the same rows.
 */
export function ResultsChart({
  settings,
  view = "accuracy-cost",
  onActiveChange,
  onHighlightChange,
  selectedId = null,
}: {
  settings: PublicSetting[];
  view?: ChartView;
  onActiveChange?: (id: string | null) => void;
  onHighlightChange?: (ids: ReadonlySet<string> | null) => void;
  /** A setting to light up as if pointed at: the table row under the pointer. */
  selectedId?: string | null;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A layout switch changes the chart's width in one commit. Measuring before paint redraws it
  // at the new width in that same frame, so the page's layout transition moves the chart as it
  // will be, not a stretched picture of the old one.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const next = Math.max(320, element.getBoundingClientRect().width);
    if (Math.abs(next - width) >= 0.5) setWidth(next);
  });
  const narrow = width < 560;
  const plotted = settings.flatMap((setting) => {
    // A setting that recorded no spend is left off the cost chart, as the page has always done.
    if (view === "accuracy-cost" && setting.costPerTaskUsd <= 0) return [];
    const at = viewPoint(view, {
      accuracy: setting.accuracy,
      cost: setting.costPerTaskUsd,
      minutes: setting.minutesPerTask,
    });
    return at ? [{ setting, at }] : [];
  });
  const lowest = Math.min(...settings.map((setting) => setting.accuracy));
  return (
    <div ref={frame} className="relative [&_svg>text[text-anchor=end]]:hidden">
      {plotted.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
          No settings have a result this view can plot.
        </p>
      ) : (
        <ResultsPlot
          title={`${viewLabel(view)} for every model setting`}
          showTitle={false}
          showLegend={false}
          selectedId={selectedId}
          onActivePointChange={(point) => onActiveChange?.(point?.id ?? null)}
          onHighlightChange={(points) =>
            onHighlightChange?.(points ? new Set(points.map((point) => point.id)) : null)
          }
          width={width}
          // Room for the vendor chips above the plot: a row on a desktop, a few taller rows on a
          // phone, where each chip is a fingertip high.
          height={narrow ? 440 : 450}
          // Larger text on a narrow chart, which a phone shows at arm's length.
          textScale={narrow ? 1.35 : 1.25}
          // A highlighted vendor chip names its points, placed clear of each other.
          labelPlacement="auto"
          // Near enough counts: the pointer, or a finger, inspects the nearest point within reach.
          hoverRadius={36}
          points={plotted.map(({ setting, at }) => ({
            id: setting.id,
            label: settingLabel(setting, settings),
            ...(setting.reasoningLevel === "default" ? {} : { note: setting.reasoningLevel }),
            x: at.x,
            y: at.y,
            ...vendorPoint(setting, setting.custom ? setting.model.label : undefined),
            description: `${harnessLabel(setting)} · ${setting.reasoningLevel} · ${setting.passed} / ${setting.tasks} passed`,
          }))}
          {...viewAxes(view, { lowestAccuracy: lowest, narrow })}
        />
      )}
      {plotted.length > 0 && (
        <span className="pointer-events-none absolute right-1 bottom-0 text-[11px] tracking-normal text-muted-foreground">
          {ACROSS[view]}
          {view === "accuracy-cost" && <span className="opacity-60"> (Log Scale)</span>}
        </span>
      )}
    </div>
  );
}
