import { paretoFrontier } from "@mupt-ai/dari-pareto";
import { ChartScatter, Maximize2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import { vendorColor } from "../../public-site/format";
import { Dialog, DialogHeader } from "../Dialog";
import { buttonStyles, Select } from "../ui";
import type { BenchmarkPoint } from "./benchmark";
import { ParetoChart } from "./ParetoChart";
import { type AcceptedTask, useRepoRuns } from "./RepoRuns";
import { configurationPoint, taskSets } from "./results-chart";
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

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayLabel = (iso: string) => day.format(new Date(iso));

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

/**
 * The model comparison chart, on the Results page: a small preview in the repository header that
 * opens the full chart in a dialog, or on a phone a Chart button in the page's actions. Hidden
 * until some run can be charted.
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
  const [chosen, setChosen] = useState<number>();
  const configurations = useMemo(() => configurationsOf(runs, credentials), [runs, credentials]);
  const sets = useMemo(
    () => taskSets(configurations, accepted ?? tasksRun(configurations)),
    [configurations, accepted],
  );
  if (!onResults || !sets.length) return null;
  // The newest set unless another was picked; a pick that no longer exists falls back to it.
  const set = sets.find((entry) => entry.tasks.length === chosen) ?? sets[0];
  if (!set) return null;
  const points = set.configurations.map((configuration) => configurationPoint(configuration, set));
  const left = configurations.length - points.length;
  const plural = (count: number, word: string) =>
    `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
  const setLabel = (entry: (typeof sets)[number]) =>
    [
      plural(entry.tasks.length, "task"),
      ...(entry.acceptedBy ? [`accepted by ${dayLabel(entry.acceptedBy)}`] : []),
      plural(entry.configurations.length, "configuration"),
    ].join(" · ");
  return (
    <>
      {variant === "button" ? (
        <button
          type="button"
          className={buttonStyles.secondary}
          aria-label="Open Model Comparison"
          onClick={() => setOpen(true)}
        >
          <ChartScatter aria-hidden="true" />
          Chart
        </button>
      ) : (
        <button
          type="button"
          className="group flex items-center gap-3 border border-border bg-card px-2.5 py-2 text-left text-muted-foreground hover:border-foreground/35 hover:text-foreground"
          aria-label="Open Model Comparison"
          title="Open Model Comparison"
          onClick={() => setOpen(true)}
        >
          <MiniChart points={points} />
          {/* Centered against the chart, so the space above and below the text is the same. */}
          <span className="flex shrink-0 flex-col justify-center gap-1 whitespace-nowrap">
            <span className="text-xs leading-4 font-semibold text-foreground">
              Model Comparison
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[11px] leading-4">
              <Maximize2
                className="size-3 shrink-0 opacity-60 group-hover:opacity-100"
                aria-hidden="true"
              />
              {plural(points.length, "point")} · {plural(set.tasks.length, "task")}
            </span>
          </span>
        </button>
      )}
      {open && (
        <Dialog
          initialFocus={close}
          onDismiss={() => setOpen(false)}
          size="wide"
          aria-labelledby="model-comparison-title"
          // The app's dialogs ignore Escape (closedby="none"); this one closes on it.
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <DialogHeader
            title="Model Comparison"
            titleId="model-comparison-title"
            description="Each configuration's latest usable result on every task in the set; a configuration missing any is left out. Select a point to open its latest run."
            onClose={() => setOpen(false)}
            closeRef={close}
          />
          <div className="p-4 sm:p-6">
            {sets.length > 1 && (
              <label
                htmlFor="model-comparison-tasks"
                className="mb-4 flex flex-wrap items-center gap-3.5 text-sm font-medium text-muted-foreground"
              >
                Tasks
                <Select
                  id="model-comparison-tasks"
                  value={set.tasks.length}
                  onChange={(event) => setChosen(Number(event.target.value))}
                >
                  {sets.map((entry) => (
                    <option key={entry.tasks.length} value={entry.tasks.length}>
                      {setLabel(entry)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <ParetoChart
              points={points}
              showTitle={false}
              onSelect={(runId) => {
                setOpen(false);
                navigate(`/repos/${repo}/results?run=${encodeURIComponent(runId)}`);
              }}
            />
            {left > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {plural(left, "configuration")} not charted: missing a usable result on some of
                these tasks.
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
