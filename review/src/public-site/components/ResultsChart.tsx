import { ParetoPlot } from "@mupt-ai/dari-pareto";
import { useEffect, useRef, useState } from "react";
import type { PublicSetting } from "../contract";
import {
  accuracyTick,
  dollars,
  harnessLabel,
  settingLabel,
  VENDOR_CHIPS,
  vendorPoint,
} from "../format";

/** The plot's colors and type, taken from the site theme so it follows light and dark. */
const THEMED = [
  "[--pareto-background:var(--card)]",
  "[--pareto-tooltip-background:var(--background)]",
  "[--pareto-foreground:var(--foreground)]",
  "[--pareto-muted:var(--muted-fg)]",
  "[--pareto-grid:var(--border)]",
  "[--pareto-point:var(--faint)]",
  "[--pareto-frontier:var(--foreground)]",
  "[--pareto-frontier-line:var(--muted-fg)]",
  "[--pareto-font-family:var(--mono)]",
].join(" ");

/** Accuracy against cost per task, one point per setting, colored by model vendor. */
export function ResultsChart({ settings }: { settings: PublicSetting[] }) {
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
  const narrow = width < 560;
  const lowest = Math.min(...settings.map((setting) => setting.accuracy));
  return (
    <div ref={frame}>
      <ParetoPlot
        className={THEMED}
        title="Accuracy versus cost per task for every model setting"
        showTitle={false}
        showLegend={false}
        width={width}
        // Room for the vendor chips above the plot: a row on a desktop, a few taller rows on a
        // phone, where each chip is a fingertip high.
        height={narrow ? 440 : 450}
        // Larger text on a narrow chart, which a phone shows at arm's length.
        textScale={narrow ? 1.35 : 1.25}
        showPointLabels={narrow ? "frontier" : "all"}
        labelPlacement="auto"
        showTooltip
        // Near enough counts: the pointer, or a finger, inspects the nearest point within reach.
        hoverRadius={36}
        // A chip per vendor above the plot, shared with the app's chart: hovering one fades the
        // other vendors' settings.
        {...VENDOR_CHIPS}
        // A quiet corner button for making the chart's text smaller or larger.
        showSettings
        points={settings.map((setting) => ({
          id: setting.id,
          label: settingLabel(setting, settings),
          x: setting.costPerTaskUsd,
          y: setting.accuracy,
          ...vendorPoint(setting, setting.custom ? setting.model.label : undefined),
          description: `${harnessLabel(setting)} · ${setting.reasoningLevel} · ${setting.passed} / ${setting.tasks} passed`,
        }))}
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
          // A little headroom so the top points and their labels clear the edge.
          domain: [Math.max(0, Math.floor((lowest - 10) / 10) * 10), 104],
          nice: true,
          ticks: 6,
          format: accuracyTick,
        }}
      />
    </div>
  );
}
