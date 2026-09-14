import { ParetoPlot } from "@mupt-ai/dari-pareto";
import { useEffect, useRef, useState } from "react";
import { type BenchmarkPoint, dollars } from "./benchmark";

export function ParetoChart({
  points,
  onSelect,
}: {
  points: BenchmarkPoint[];
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
  const oneHarness = new Set(points.map((point) => point.harness)).size === 1;
  return (
    <section
      ref={container}
      className="border border-border bg-background p-4 sm:p-6"
      aria-label="Accuracy versus Cost"
    >
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
            className="[--pareto-background:var(--background)] [--pareto-foreground:var(--foreground)] [--pareto-muted:var(--muted-fg)] [--pareto-grid:var(--border)] [--pareto-point:var(--muted-fg)] [--pareto-font-family:'DM_Mono',var(--mono)]"
            title={width < 640 ? "Accuracy vs. Cost" : "Accuracy versus Cost per Task"}
            description="Higher accuracy and lower model API cost are better. Select a point to inspect the run."
            width={width}
            height={width < 640 ? 300 : Math.round(Math.min(520, Math.max(380, width * 0.55)))}
            showLegend={width >= 640}
            points={points.map((point) => ({
              id: point.id,
              label: oneHarness ? point.name : `${point.name} · ${point.harness}`,
              x: point.cost,
              y: point.accuracy,
              description: `${point.accuracy.toFixed(1)}% at ${dollars(point.cost)} per task`,
            }))}
            xAxis={{
              label: "Cost per Task",
              objective: "minimize",
              includeZero: true,
              ticks: width < 640 ? 3 : 5,
              format: dollars,
            }}
            yAxis={{
              label: "Accuracy",
              objective: "maximize",
              // Auto range leaves headroom above the top point; never label past 100%.
              format: (value) => (value > 100 ? "" : `${value.toFixed(0)}%`),
            }}
            showPointLabels={width < 640 ? "none" : "frontier"}
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
