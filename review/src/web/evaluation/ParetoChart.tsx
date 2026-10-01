import { ParetoPlot } from "@mupt-ai/dari-pareto";
import { useEffect, useRef, useState } from "react";
import { harnessLabels } from "../../../../src/evaluation/models";
import {
  accuracyTick,
  CHART_LOOK,
  dollars as tickDollars,
  VENDOR_CHIPS,
  vendorPoint,
} from "../../public-site/format";
import { type BenchmarkPoint, type CustomEndpoint, dollars } from "./benchmark";
import { endpointLabel } from "./credential-presentation";

export function ParetoChart({
  points,
  endpoints = new Map(),
  showTitle = true,
  onSelect,
}: {
  points: BenchmarkPoint[];
  /** Custom points' endpoints and public numbers, by point id (`customEndpoints`). */
  endpoints?: ReadonlyMap<string, CustomEndpoint>;
  /** Whether to draw the title, which a dialog around the chart may already show. */
  showTitle?: boolean;
  onSelect(id: string): void;
}) {
  const container = useRef<HTMLElement>(null);
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
  const lowest = Math.min(...points.map((point) => point.accuracy));
  return (
    <section ref={container} className="panel p-4 sm:p-6" aria-label="Accuracy versus Cost">
      {!points.length ? (
        <div className="py-2 text-sm text-muted-foreground [&_span]:mt-2 [&_span]:block [&_span]:max-w-2xl [&_span]:text-xs [&_span]:leading-5">
          <p>Your completed runs appear here.</p>
          <span>
            Runs need complete scores, verified model usage, and a cost estimate. Missing costs
            aren’t plotted as zero.
          </span>
        </div>
      ) : (
        <div className="[&_svg]:block [&_svg]:w-full">
          <ParetoPlot
            {...CHART_LOOK}
            title="Model Comparison"
            showTitle={showTitle}
            description="Higher accuracy and lower model API cost are better. Select a point to inspect the run."
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
            // The public repository page's vendor chips: hovering one fades the rest.
            {...VENDOR_CHIPS}
            showSettings
            points={points.map((point) => {
              const source = { provider: point.provider, model: { name: point.model } };
              const customModel = point.provider === "custom" ? point.model : undefined;
              const label = oneHarness
                ? point.modelLabel
                : `${point.modelLabel} · ${harnessLabels[point.harness as keyof typeof harnessLabels] ?? point.harness}`;
              // A custom endpoint shows its host, and the number the public page would give it.
              const custom = endpoints.get(point.id);
              return {
                id: point.id,
                label: custom?.number ? `${label} (Endpoint ${custom.number})` : label,
                ...(point.thinking === "default" ? {} : { note: point.thinking }),
                x: point.cost,
                y: point.accuracy,
                ...vendorPoint(source, customModel),
                description: [
                  `${point.accuracy.toFixed(1)}% at ${dollars(point.cost)} per task`,
                  ...(custom ? [endpointLabel(custom.endpoint)] : []),
                ].join(" · "),
              };
            })}
            xAxis={{
              label: "Cost per Task",
              objective: "minimize",
              // Costs span orders of magnitude; on a log axis cheap runs spread out instead of
              // crowding against zero, and equal distances are equal price ratios.
              scale: "log",
              nice: true,
              ticks: narrow ? 4 : 6,
              // A short mark under each price, tying the label to its place on the axis.
              tickMarks: true,
              format: (value) => (value === 0 ? "$0.00" : tickDollars(value)),
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
            onSelect={(selected) => {
              const point = points.find((entry) => entry.id === selected.id);
              if (point) onSelect(point.runId);
            }}
          />
        </div>
      )}
    </section>
  );
}
