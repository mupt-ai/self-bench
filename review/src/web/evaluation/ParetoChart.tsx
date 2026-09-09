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
      if (entry) setWidth(Math.max(320, Math.min(1040, entry.contentRect.width)));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const oneHarness = new Set(points.map((point) => point.harness)).size === 1;
  return (
    <section
      ref={container}
      className="border border-line bg-bg p-4 sm:p-6 [&_footer]:mt-2.5 [&_footer]:font-mono [&_footer]:text-sm [&_footer]:text-dim"
      aria-label="Accuracy versus Cost"
    >
      <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-end [&_h2]:mt-2 [&_h2]:font-sans [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:tracking-tight [&_p]:font-mono [&_p]:text-base [&_p]:text-dim">
        <div>
          <span className="font-mono text-sm font-medium tracking-[0.14em] text-mint uppercase">
            Benchmark
          </span>
          <h2>Accuracy vs. Estimated Cost</h2>
        </div>
        {points.length > 0 && (
          <p>
            {points[0]?.tasks} {points[0]?.tasks === 1 ? "task" : "tasks"} · same dataset
            {oneHarness ? ` · ${points[0]?.harness}` : ""}
          </p>
        )}
      </div>
      {!points.length ? (
        <div className="py-16 text-center text-muted [&_span]:mx-auto [&_span]:mt-3 [&_span]:block [&_span]:max-w-[440px] [&_span]:text-sm [&_span]:text-dim">
          <p>Your completed runs appear here.</p>
          <span>
            Runs need complete scores, verified model usage, and a cost estimate. Missing costs
            aren’t plotted as zero.
          </span>
        </div>
      ) : (
        <div className="mt-7 [&_svg]:block [&_svg]:w-full">
          <ParetoPlot
            className="[--pareto-background:var(--bg)] [--pareto-foreground:var(--ink)] [--pareto-muted:var(--dim)] [--pareto-frontier:var(--mint)] [&_text]:text-xs [&_text[font-size='11']]:text-sm [&_text[font-size='14']]:text-sm"
            title={width < 640 ? "Accuracy vs. Cost" : "Accuracy versus Cost per Task"}
            description="Higher accuracy and lower model API cost are better. Select a point to inspect the run."
            width={width}
            height={width < 640 ? 320 : 400}
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
              domain: [0, 100],
              format: (value) => `${value.toFixed(0)}%`,
            }}
            showPointLabels="none"
            onSelect={(selected) => {
              const point = points.find((entry) => entry.id === selected.id);
              if (point) onSelect(point.runId);
            }}
          />
        </div>
      )}
      <footer>
        Estimated token cost, not an invoice. Sandbox costs excluded. Hover or focus for details.
      </footer>
    </section>
  );
}
