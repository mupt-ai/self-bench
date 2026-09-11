import { ParetoPlot } from "@mupt-ai/dari-pareto";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "../ui";
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
      className="border border-border bg-background p-4 sm:p-6 [&_footer]:mt-2.5 [&_footer]:font-mono [&_footer]:text-xs [&_footer]:text-muted-foreground"
      aria-label="Accuracy versus Cost"
    >
      <SectionHeader title="Accuracy vs. Estimated Cost">
        {points.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {points[0]?.tasks} {points[0]?.tasks === 1 ? "task" : "tasks"} · same dataset
            {oneHarness ? ` · ${points[0]?.harness}` : ""}
          </p>
        )}
      </SectionHeader>
      {!points.length ? (
        <div className="py-16 text-center text-muted-foreground [&_span]:mx-auto [&_span]:mt-3 [&_span]:block [&_span]:max-w-[440px] [&_span]:text-sm [&_span]:text-muted-foreground">
          <p>Your completed runs appear here.</p>
          <span>
            Runs need complete scores, verified model usage, and a cost estimate. Missing costs
            aren’t plotted as zero.
          </span>
        </div>
      ) : (
        <div className="mt-4 [&_svg]:block [&_svg]:w-full">
          <ParetoPlot
            className="[--pareto-background:var(--background)] [--pareto-foreground:var(--foreground)] [--pareto-muted:var(--muted-fg)] [--pareto-frontier:var(--brand)] [--pareto-grid:var(--border)] [--pareto-point:var(--muted-fg)] [--pareto-font-family:var(--mono)] [&_text]:text-xs [&_text[font-size='11']]:text-sm [&_text[font-size='14']]:text-sm"
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
