import { paretoFrontier } from "@mupt-ai/dari-pareto";
import { ChartScatter, Maximize2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import { vendorColor } from "../../public-site/format";
import { Dialog, DialogHeader } from "../Dialog";
import { buttonStyles } from "../ui";
import type { BenchmarkPoint } from "./benchmark";
import { ChartConfigurations, useChosen } from "./ChartConfigurations";
import { ParetoChart } from "./ParetoChart";
import { type AcceptedTask, useRepoRuns } from "./RepoRuns";
import { configurationPoint, coverageOf, defaultPicks, sharedTasks } from "./results-chart";
import { type Configuration, configurationsOf } from "./results-model";

/**
 * Until the accepted tasks load, or if they can't, the tasks some configuration has a usable
 * result for, with no acceptance times. A task nobody has one for (one that errored everywhere,
 * say) is left out, or no configuration could cover the set and the chart would never show.
 */
function tasksRun(configurations: readonly Configuration[]): AcceptedTask[] {
  const seen = new Map<string, AcceptedTask>();
  for (const configuration of configurations) {
    for (const { trial } of configuration.latest) {
      if (!eligibleTrial(trial)) continue;
      seen.set(`${trial.runId}/${trial.taskId}`, {
        runId: trial.runId,
        taskId: trial.taskId,
        difficulty: "",
      });
    }
  }
  return [...seen.values()];
}

const WIDTH = 132;
const HEIGHT = 44;
const PAD = 4;

/**
 * The chart in miniature: each point in its vendor's color on a log cost axis, and the frontier
 * joining the best ones. No axes or labels; the dialog has those.
 */
function MiniChart({ points }: { points: readonly BenchmarkPoint[] }) {
  const costs = points.map((point) => Math.log10(Math.max(point.cost, 1e-4)));
  const accuracies = points.map((point) => point.accuracy);
  const span = (values: number[]) => {
    const [low, high] = [Math.min(...values), Math.max(...values)];
    return high > low ? [low, high] : [low - 1, high + 1];
  };
  const [x0, x1] = span(costs);
  const [y0, y1] = span(accuracies);
  const x = (point: BenchmarkPoint) =>
    PAD +
    ((Math.log10(Math.max(point.cost, 1e-4)) - (x0 ?? 0)) / ((x1 ?? 1) - (x0 ?? 0))) *
      (WIDTH - 2 * PAD);
  const y = (point: BenchmarkPoint) =>
    HEIGHT - PAD - ((point.accuracy - (y0 ?? 0)) / ((y1 ?? 1) - (y0 ?? 0))) * (HEIGHT - 2 * PAD);
  const frontier = paretoFrontier(
    points.map((point) => ({
      ...point,
      id: point.id,
      label: point.name,
      x: point.cost,
      y: point.accuracy,
    })),
    { xObjective: "minimize", yObjective: "maximize" },
  ).sort((a, b) => a.cost - b.cost);
  return (
    <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
      <polyline
        points={frontier.map((point) => `${x(point)},${y(point)}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.45}
        strokeDasharray="2 2"
      />
      {points.map((point) => (
        <circle
          key={point.id}
          cx={x(point)}
          cy={y(point)}
          r={2.5}
          fill={vendorColor({ provider: point.provider, model: { name: point.model } })}
        />
      ))}
    </svg>
  );
}

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/**
 * The Results chart: a small preview in the repository header that opens the full chart in a
 * dialog, or on a phone a Chart button in the page's actions. The chart plots the configurations
 * chosen in the dialog over the accepted tasks all of them have a usable result on, as a release
 * does with the settings ticked. Hidden until some configuration has a usable result.
 */
export function ChartPreview({
  repo,
  variant = "card",
}: {
  repo: string;
  /** The header's card, or on a phone, where the card has no room, a plain Chart button. */
  variant?: "card" | "button";
}) {
  const { runs, credentials, accepted, onResults } = useRepoRuns();
  const navigate = useNavigate();
  const close = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saved, choose] = useChosen(repo);
  const configurations = useMemo(() => configurationsOf(runs, credentials), [runs, credentials]);
  const tasks = useMemo(
    () => (accepted ?? tasksRun(configurations)).map((task) => `${task.runId}/${task.taskId}`),
    [configurations, accepted],
  );
  // Only configurations with a usable result on some accepted task can be charted.
  const options = useMemo(
    () =>
      configurations.flatMap((configuration) => {
        const coverage = coverageOf(configuration, tasks);
        return coverage.length ? [{ configuration, coverage }] : [];
      }),
    [configurations, tasks],
  );
  const fallback = useMemo(
    () => defaultPicks(configurations, tasks).map((configuration) => configuration.key),
    [configurations, tasks],
  );
  if (!onResults || !options.length) return null;
  // Chosen configurations no longer offered drop out; if that leaves none of a choice, or nothing
  // was chosen, the default. Clearing every box is a choice, and charts nothing.
  const kept = saved?.filter((key) => options.some((option) => option.configuration.key === key));
  const ticked = new Set(!kept || (saved?.length && !kept.length) ? fallback : kept);
  const chosen = options
    .filter((option) => ticked.has(option.configuration.key))
    .map((option) => option.configuration);
  const shared = sharedTasks(chosen, tasks);
  const points = shared.length
    ? chosen.map((configuration) => configurationPoint(configuration, shared))
    : [];
  const summary = !chosen.length
    ? "Choose configurations to chart."
    : !shared.length
      ? "They share no accepted task with a usable result. Untick one to chart the rest."
      : `Over the ${plural(shared.length, "accepted task")} all of them have a usable result on.`;
  return (
    <>
      {variant === "button" ? (
        <button
          type="button"
          className={buttonStyles.secondary}
          aria-label="Open Chart"
          onClick={() => setOpen(true)}
        >
          <ChartScatter aria-hidden="true" />
          Chart
        </button>
      ) : (
        <button
          type="button"
          className="group flex items-center gap-3 border border-border bg-card px-2.5 py-2 text-left text-muted-foreground hover:border-foreground/35 hover:text-foreground"
          aria-label="Open Chart"
          title="Open Chart"
          onClick={() => setOpen(true)}
        >
          <MiniChart points={points} />
          {/* Centered against the chart, so the space above and below the text is the same. */}
          <span className="flex shrink-0 flex-col justify-center gap-1 whitespace-nowrap">
            <span className="text-xs leading-4 font-semibold text-foreground">Chart</span>
            <span className="flex items-center gap-1.5 font-mono text-[11px] leading-4">
              <Maximize2
                className="size-3 shrink-0 opacity-60 group-hover:opacity-100"
                aria-hidden="true"
              />
              {plural(points.length, "point")} · {plural(shared.length, "task")}
            </span>
          </span>
        </button>
      )}
      {open && (
        <Dialog
          initialFocus={close}
          onDismiss={() => setOpen(false)}
          size="wide"
          aria-labelledby="results-chart-title"
          // The app's dialogs ignore Escape (closedby="none"); this one closes on it.
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <DialogHeader
            title="Chart"
            titleId="results-chart-title"
            description="Each chosen configuration's latest usable result on every accepted task all of them have one for. Select a point to open its latest run."
            onClose={() => setOpen(false)}
            closeRef={close}
          />
          <div className="p-4 sm:p-6">
            <ChartConfigurations
              options={options}
              tasks={tasks.length}
              ticked={ticked}
              custom={saved !== undefined}
              summary={summary}
              choose={choose}
            />
            {points.length ? (
              <ParetoChart
                points={points}
                showTitle={false}
                onSelect={(runId) => {
                  setOpen(false);
                  navigate(`/repos/${repo}/results?run=${encodeURIComponent(runId)}`);
                }}
              />
            ) : (
              <p className="panel p-4 text-sm text-muted-foreground sm:p-6">{summary}</p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
