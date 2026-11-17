import { useEffect, useRef, useState } from "react";
import { harnessLabels } from "../../../../src/evaluation/models";
import {
  CHART_VIEWS,
  type ChartView,
  viewAxes,
  viewLabel,
  viewPoint,
} from "../../public-site/chart-views";
import { ChartViewChips } from "../../public-site/components/ChartViewChips";
import { ResultsPlot } from "../../public-site/components/ResultsPlot";
import { vendorPoint } from "../../public-site/format";
import { type BenchmarkPoint, dollars } from "./benchmark";

export function ParetoChart({
  points,
  showTitle = true,
  onSelect,
}: {
  points: BenchmarkPoint[];
  /** Whether to draw the title, which a dialog around the chart may already show. */
  showTitle?: boolean;
  onSelect(id: string): void;
}) {
  const container = useRef<HTMLElement>(null);
  const [view, setView] = useState<ChartView>("accuracy-cost");
  const [width, setWidth] = useState(1040);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const narrow = width < 640;
  const oneHarness = new Set(points.map((point) => point.harness)).size === 1;
  const plotted = points.flatMap((point) => {
    const at = viewPoint(view, {
      accuracy: point.accuracy,
      cost: point.cost,
      minutes: point.minutes,
    });
    return at ? [{ point, at }] : [];
  });
  const lowest = Math.min(...plotted.map(({ point }) => point.accuracy));
  const description = CHART_VIEWS.find((entry) => entry.id === view)?.description ?? "";
  return (
    <section ref={container} className="panel p-4 sm:p-6" aria-label={viewLabel(view)}>
      <div className="mb-3">
        <ChartViewChips view={view} onChange={setView} />
      </div>
      {!points.length ? (
        <div className="py-2 text-sm text-muted-foreground [&_span]:mt-2 [&_span]:block [&_span]:max-w-2xl [&_span]:text-xs [&_span]:leading-5">
          <p>Your completed runs appear here.</p>
          <span>
            Runs need complete scores, verified model usage, and a cost estimate. Missing costs
            aren’t plotted as zero.
          </span>
        </div>
      ) : !plotted.length ? (
        <p className="py-2 text-sm text-muted-foreground">
          No runs have a result this view can plot. Time views need timed trials.
        </p>
      ) : (
        <div className="[&_svg]:block [&_svg]:w-full">
          <ResultsPlot
            title={viewLabel(view)}
            showTitle={showTitle}
            description={`${description} Select a point to inspect the run.`}
            width={width}
            // Room for the title and the vendor chips above the plot: a row on a desktop, a few
            // on a phone.
            height={narrow ? 440 : Math.round(Math.min(560, Math.max(440, width * 0.55)))}
            textScale={narrow ? 1.3 : 1.2}
            showLegend={!narrow}
            // A highlighted vendor chip names its points, placed clear of each other.
            labelPlacement="auto"
            // Near enough counts: the pointer, or a finger, inspects the nearest point within reach.
            hoverRadius={36}
            showSettings
            points={plotted.map(({ point, at }) => {
              const source = { provider: point.provider, model: { name: point.model } };
              const customModel = point.provider === "custom" ? point.model : undefined;
              const label = oneHarness
                ? point.modelLabel
                : `${point.modelLabel} · ${harnessLabels[point.harness as keyof typeof harnessLabels] ?? point.harness}`;
              return {
                id: point.id,
                label,
                ...(point.thinking === "default" ? {} : { note: point.thinking }),
                x: at.x,
                y: at.y,
                ...vendorPoint(source, customModel),
                description: `${point.accuracy.toFixed(1)}% at ${dollars(point.cost)} per task${point.minutes === undefined ? "" : `, ${Math.round(point.minutes)} min per task`}`,
              };
            })}
            {...viewAxes(view, { lowestAccuracy: lowest, narrow })}
            onSelect={(selected) => {
              const point = plotted.find((entry) => entry.point.id === selected.id)?.point;
              if (point) onSelect(point.runId);
            }}
          />
        </div>
      )}
    </section>
  );
}
