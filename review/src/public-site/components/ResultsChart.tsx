import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { accuracyInterval } from "../../../../src/public/accuracy-interval";
import type { PublicSetting } from "../contract";
import {
  accuracyDomain,
  accuracyTick,
  dollars,
  harnessLabel,
  intervalNote,
  settingLabel,
  vendorPoint,
} from "../format";
import { ResultsPlot } from "./ResultsPlot";

/**
 * Accuracy against cost per task, one point per setting, colored by model vendor. It tells the
 * page which setting the pointer is on, and which settings a vendor chip highlights, so the
 * table below can mark the same rows.
 */
export function ResultsChart({
  settings,
  onActiveChange,
  onHighlightChange,
  selectedId = null,
}: {
  settings: PublicSetting[];
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
  return (
    <div ref={frame}>
      <ResultsPlot
        title="Accuracy versus cost per task for every model setting"
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
        // A quiet corner button for making the chart's text smaller or larger.
        showSettings
        points={settings.map((setting) => {
          const interval = accuracyInterval(setting);
          return {
            id: setting.id,
            label: settingLabel(setting, settings),
            ...(setting.reasoningLevel === "default" ? {} : { note: setting.reasoningLevel }),
            x: setting.costPerTaskUsd,
            y: setting.accuracy,
            ...(interval ? { yInterval: interval } : {}),
            ...vendorPoint(setting, setting.custom ? setting.model.label : undefined),
            description: [
              harnessLabel(setting),
              setting.reasoningLevel,
              `${setting.passed} / ${setting.tasks} passed`,
              ...(interval ? [intervalNote(interval)] : []),
            ].join(" · "),
          };
        })}
        xAxis={{
          label: "Cost per Task",
          objective: "minimize",
          // Costs span orders of magnitude; on a log axis cheap settings spread out instead
          // of crowding against zero, and equal distances are equal price ratios.
          scale: "log",
          nice: true,
          ticks: narrow ? 4 : 6,
          // A short mark under each price, tying the label to its place on the axis.
          tickMarks: true,
          // "$0.00" rather than dollars()'s "$0", so the first tick matches the ones after it.
          format: (value) => (value === 0 ? "$0.00" : dollars(value)),
        }}
        yAxis={{
          label: "Accuracy",
          objective: "maximize",
          domain: accuracyDomain(settings),
          nice: true,
          ticks: 6,
          format: accuracyTick,
        }}
      />
    </div>
  );
}
