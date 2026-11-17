import type { ParetoPlotProps } from "@mupt-ai/dari-pareto";
import { accuracyTick, dollars } from "./format";

/**
 * The results chart's views. Each names its axes "Y versus X", as the chart's title does, and time
 * is always across: a setting's time is its tasks' wall-clock minutes, so a view reads the same
 * on a repository page and in the app.
 */
export type ChartView = "accuracy-cost" | "accuracy-time" | "cost-time";

export const CHART_VIEWS: readonly { id: ChartView; label: string; description: string }[] = [
  {
    id: "accuracy-cost",
    label: "Accuracy versus Cost",
    description: "Higher accuracy and lower model API cost are better.",
  },
  {
    id: "accuracy-time",
    label: "Accuracy versus Time",
    description: "Higher accuracy and less time per task are better.",
  },
  {
    id: "cost-time",
    label: "Cost versus Time",
    description: "Lower model API cost and less time per task are better. Cost is on a log scale.",
  },
];

/** What a point is measured by: a setting's or a configuration's figures. */
export interface ChartMeasure {
  accuracy: number;
  /** Mean model API cost per task, in dollars. */
  cost: number;
  /** Mean wall-clock minutes per task, when its tasks were timed. */
  minutes?: number;
}

/** Minutes as a tick or a word: "45 min", "2 h", "1.5 h". */
export function minutesTick(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${Number((minutes / 60).toFixed(1))} h`;
}

/** The point a view draws for a measure, or undefined when the view cannot place it. */
export function viewPoint(
  view: ChartView,
  measure: ChartMeasure,
): { x: number; y: number } | undefined {
  if (view === "accuracy-cost") return { x: measure.cost, y: measure.accuracy };
  if (measure.minutes === undefined) return undefined;
  if (view === "accuracy-time") return { x: measure.minutes, y: measure.accuracy };
  // A log axis cannot place a measure that recorded no spend.
  return measure.cost > 0 ? { x: measure.minutes, y: measure.cost } : undefined;
}

/** The axes a view draws, with the accuracy domain starting a little below the lowest point. */
export function viewAxes(
  view: ChartView,
  options: { lowestAccuracy: number; narrow: boolean },
): Pick<ParetoPlotProps, "xAxis" | "yAxis"> {
  const { lowestAccuracy, narrow } = options;
  const accuracy: ParetoPlotProps["yAxis"] = {
    label: "Accuracy",
    objective: "maximize",
    // A little headroom so the top points and their labels clear the edge.
    domain: [Math.max(0, Math.floor((lowestAccuracy - 10) / 10) * 10), 104],
    nice: true,
    ticks: 6,
    format: accuracyTick,
  };
  const time: ParetoPlotProps["xAxis"] = {
    label: "Time per Task",
    objective: "minimize",
    nice: true,
    ticks: narrow ? 4 : 6,
    tickMarks: true,
    format: minutesTick,
  };
  // Costs span orders of magnitude; on a log axis cheap settings spread out instead of crowding
  // against zero, and equal distances are equal price ratios.
  const cost: ParetoPlotProps["xAxis"] = {
    label: "Cost per Task",
    objective: "minimize",
    scale: "log",
    nice: true,
    ticks: narrow ? 4 : 6,
    // A short mark under each price, tying the label to its place on the axis.
    tickMarks: true,
    // "$0.00" rather than dollars()'s "$0", so the first tick matches the ones after it.
    format: (value) => (value === 0 ? "$0.00" : dollars(value)),
  };
  if (view === "accuracy-cost") return { xAxis: cost, yAxis: accuracy };
  if (view === "accuracy-time") return { xAxis: time, yAxis: accuracy };
  return { xAxis: time, yAxis: cost };
}

/** The view's name, for the chart's title and its accessible name. */
export function viewLabel(view: ChartView): string {
  return CHART_VIEWS.find((entry) => entry.id === view)?.label ?? "Chart";
}
