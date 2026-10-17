import { ParetoPlot, type ParetoPoint } from "@mupt-ai/dari-pareto";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { PublicSetting } from "../public-site/contract";
import {
  accuracyTick,
  CHART_LOOK,
  dollars,
  percent,
  VENDOR_CHIPS,
  vendorColor,
  vendorPoint,
} from "../public-site/format";
import {
  catalogModel,
  focusSetting,
  labelSpot,
  momentAt,
  pointsAt,
  SEGMENT,
  type Shown,
  type VideoConfig,
  type VideoRepo,
} from "./motion";

/**
 * The benchmark video's page: one frame per renderAt(t), drawn with the results chart the site
 * uses. scripts/benchmark-video.ts builds it, feeds it window.VIDEO and records the frames.
 */

const CONFIG = (window as unknown as { VIDEO: VideoConfig }).VIDEO;
const { model, repos } = CONFIG;
const extras = new Map(CONFIG.extras.map((extra) => [extra.model, extra]));

/** Named on the chart and left undimmed: the highlighted model, the frontier and the extras. */
const labeled = (setting: PublicSetting) =>
  catalogModel(setting) === model || extras.has(catalogModel(setting)) || setting.onFrontier;

/** Each repository with the highlighted model's setting there; the script checked it ran on all. */
const shots = repos.map((repo) => ({ repo, focus: focusSetting(repo, model) }));
function shot(index: number): { repo: VideoRepo; focus: PublicSetting } {
  const { repo, focus } = shots[index] ?? {};
  if (!repo || !focus) throw new Error(`${model} has no setting in repository ${index}`);
  return { repo, focus };
}
const FOCUS = shot(0).focus;
const FOCUS_LABEL = FOCUS.model.label;

function Header({ repo, focus, alpha }: { repo: VideoRepo; focus: PublicSetting; alpha: number }) {
  const rank = [...repo.settings].sort((a, b) => b.accuracy - a.accuracy).indexOf(focus) + 1;
  return (
    <header className="head">
      <div>
        <div className="brand">
          <img src="dari-logo.svg" alt="" />
          <span>SelfBench</span>
        </div>
        <h1>
          <span className="focus">{FOCUS_LABEL}</span> {CONFIG.title}
        </h1>
        <div className="repo" style={{ opacity: alpha }}>
          <img src={repo.avatar} alt="" />
          <span className="name">{repo.name}</span>
          <span className="tasks">{repo.tasks} tasks from merged PRs</span>
        </div>
      </div>
      <div className="stat" style={{ opacity: alpha }}>
        <div className="big">{percent(focus.accuracy)}</div>
        <div className="small">
          <span className="focus">{dollars(focus.costPerTaskUsd)}/task</span> · #{rank} of{" "}
          {repo.settings.length} settings
        </div>
      </div>
    </header>
  );
}

function Frame({ t }: { t: number }) {
  const { from, to, p, morphing, focusIn } = momentAt(t, repos.length);
  const shown = pointsAt(shot(from).repo, shot(to).repo, p, (setting) =>
    catalogModel(setting) === model ? 2 : labeled(setting) ? 1 : 0,
  );
  const { repo, focus } = shot(p < 0.5 ? from : to);
  const fade = morphing ? Math.abs(1 - 2 * p) : 1;
  const points: ParetoPoint[] = shown.map(({ setting, x, y }) => {
    const extra = extras.get(catalogModel(setting));
    return {
      id: setting.id,
      label: labeled(setting) ? setting.model.label : "",
      note: labeled(setting) ? (extra?.note ?? setting.reasoningLevel) : undefined,
      x,
      y,
      ...vendorPoint(setting, setting.custom ? setting.model.label : undefined),
    };
  });
  return (
    <div className="frame" style={{ "--focus": vendorColor(FOCUS) } as React.CSSProperties}>
      <Header repo={repo} focus={focus} alpha={fade} />
      <div className="panel">
        <ParetoPlot
          {...CHART_LOOK}
          {...VENDOR_CHIPS}
          className="plot"
          mode="static"
          title="Accuracy versus cost per task"
          showTitle={false}
          showLegend={false}
          showPointLabels="all"
          labelPlacement="auto"
          width={896}
          height={430}
          textScale={1.4}
          points={points}
          xAxis={{
            label: "Cost per Task",
            objective: "minimize",
            scale: "log",
            domain: [0.01, 10],
            nice: true,
            ticks: 6,
            tickMarks: true,
            format: (value) => (value === 0 ? "$0.00" : dollars(value)),
          }}
          yAxis={{
            label: "Accuracy",
            objective: "maximize",
            domain: [20, 100],
            nice: true,
            ticks: 5,
            format: accuracyTick,
          }}
        />
      </div>
      <footer>
        <span>Accuracy vs. cost per task on each repository's own merged pull requests</span>
        <span className="url">selfbench.dev</span>
      </footer>
      <Opacity shown={shown} focusIn={focusIn} frontier={fade} />
    </div>
  );
}

/** Per-point opacity, by draw order: the plot has no per-point style of its own. */
function Opacity({
  shown,
  focusIn,
  frontier,
}: {
  shown: Shown[];
  focusIn: number;
  frontier: number;
}) {
  const rules = shown.map((s, i) => {
    const dim = labeled(s.setting) ? 1 : 1 - 0.55 * focusIn;
    return `.plot g > g.pareto-point:nth-child(${i + 1}) { opacity: ${(s.alpha * dim).toFixed(3)}; }`;
  });
  return (
    <style>
      {rules.join("\n")}
      {`.plot .pareto-point-label { opacity: ${focusIn.toFixed(3)} !important; }`}
      {`.plot polyline { opacity: ${(0.7 * frontier).toFixed(3)}; }`}
      {/* The enlarged model label is placed without knowing the frontier's, so that one steps aside. */}
      {`.plot .pareto-frontier-label { opacity: ${(0.7 * frontier * (1 - focusIn)).toFixed(3)}; }`}
    </style>
  );
}

const number = (element: Element, name: string) => Number(element.getAttribute(name));

/**
 * The plot places every label as if all were one size, so the enlarged highlighted label is
 * moved to the spot around its point that collides with the least.
 */
function placeFocusLabel() {
  const svg = document.querySelector<SVGSVGElement>(".plot");
  const labels = [...document.querySelectorAll<SVGTextElement>(".plot .pareto-point-label")];
  const label = labels.find((l) => l.textContent?.startsWith(FOCUS_LABEL));
  for (const l of labels) l.classList.toggle("focus", l === label);
  const circles = [...document.querySelectorAll(".plot g.pareto-point circle:not(.pareto-hit)")];
  const point = circles.at(-1);
  if (!svg || !label || !point) return;
  label.setAttribute("text-anchor", "start");
  const { width, height } = label.getBBox();
  const view = svg.viewBox.baseVal;
  const line = (document.querySelector(".plot polyline")?.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number) as [number, number]);
  const [x, y] = labelSpot(
    [number(point, "cx"), number(point, "cy")],
    { width, height },
    {
      marks: circles
        .filter((c) => c !== point)
        .map((c) => ({ x: number(c, "cx") - 6, y: number(c, "cy") - 6, width: 12, height: 12 })),
      labels: labels.filter((l) => l !== label).map((l) => l.getBBox()),
      line,
      bounds: { x: 50, y: 40, width: view.width - 60, height: view.height - 90 },
    },
  );
  // The baseline sits about four fifths of the way down the text's box.
  label.setAttribute("x", String(x));
  label.setAttribute("y", String(y + height * 0.8));
}

const mount = document.getElementById("root");
if (!mount) throw new Error("the video page has no #root");
const root = createRoot(mount);
Object.assign(window, {
  DURATION: SEGMENT * repos.length,
  renderAt(t: number) {
    flushSync(() => root.render(<Frame t={t} />));
    placeFocusLabel();
  },
});
