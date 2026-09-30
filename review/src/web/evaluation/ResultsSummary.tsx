import { cn } from "../primitives/cn";
import { dollars } from "./benchmark";
import { type Alert, needsAttention, type Review } from "./results-alerts";
import type { Configuration, Outcome } from "./results-model";

/** The page at a glance: how many configurations, what's running, what needs a look, and spend. */
export function ResultsSummary({
  configurations,
  review,
}: {
  configurations: readonly Configuration[];
  review: Review;
}) {
  const sum = (outcome: Outcome) =>
    configurations.reduce((total, configuration) => total + configuration.counts[outcome], 0);
  const total = configurations.reduce(
    (count, configuration) => count + configuration.latest.length,
    0,
  );
  const finished = configurations.reduce(
    (count, configuration) => count + configuration.finished,
    0,
  );
  const spend = configurations.reduce((count, configuration) => count + configuration.spend, 0);
  const bar: [Outcome, string, string][] = [
    ["passed", "bg-success", "passed"],
    ["failed", "bg-muted-foreground/60", "failed"],
    ["error", "bg-destructive", "errored"],
    ["running", "bg-check", "running"],
  ];
  const stats = [
    { value: configurations.length, label: "Configurations" },
    {
      value: configurations.filter((configuration) => configuration.status === "running").length,
      label: "Running",
    },
    {
      value: configurations.filter((configuration) => needsAttention(review, configuration)).length,
      label: "Need Attention",
    },
  ];
  return (
    // Value above label, though a definition list names each value first. The gaps are the rules.
    <dl className="panel mb-4 grid grid-flow-row-dense grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col-reverse [&>div]:justify-end [&>div]:gap-0.5 [&>div]:bg-card [&>div]:px-4 [&>div]:py-3 [&_dd]:font-mono [&_dd]:text-lg [&_dd]:leading-tight [&_dd]:font-semibold [&_dd]:tabular-nums [&_dt]:text-xs [&_dt]:text-muted-foreground">
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt>{stat.label}</dt>
          <dd>{stat.value}</dd>
        </div>
      ))}
      <div className="col-span-2">
        <div
          className="mt-1.5 flex h-1.5 bg-muted"
          role="img"
          aria-label={bar.map(([outcome, , word]) => `${sum(outcome)} ${word}`).join(", ")}
        >
          {total > 0 &&
            bar.map(([outcome, color]) => (
              <i
                key={outcome}
                className={cn("block h-full", color)}
                style={{ width: `${(sum(outcome) / total) * 100}%` }}
              />
            ))}
        </div>
        <dt>
          Tasks Finished · {sum("running")} running · {sum("queued")} queued
        </dt>
        <dd>
          {finished} / {total}
        </dd>
      </div>
      <div>
        <dt>Model Spend</dt>
        <dd>{dollars(spend)}</dd>
      </div>
    </dl>
  );
}

const alertTones: Record<Alert["severity"], { edge: string; icon: string }> = {
  bad: { edge: "bg-destructive", icon: "text-destructive" },
  warn: { edge: "bg-warning", icon: "text-warning" },
  info: { edge: "bg-muted-foreground/50", icon: "text-muted-foreground" },
};

const alertIcons: Record<Alert["kind"], string> = {
  "repeated-error": "!",
  "task-problem": "#",
  stalled: "‖",
  "wont-chart": "◌",
  cancelled: "×",
};

/** Page-wide banners, worst first; each one's Show button takes the table to it. */
export function ResultsAlerts({
  alerts,
  onShow,
}: {
  alerts: readonly Alert[];
  onShow(alert: Alert): void;
}) {
  if (!alerts.length) return null;
  return (
    <ul className="panel mb-4 divide-y divide-border" aria-label="Alerts">
      {alerts.map((alert) => (
        <li
          key={`${alert.kind}/${alert.configuration ?? alert.task?.key}/${alert.detail}`}
          className="grid grid-cols-[4px_1.5rem_minmax(0,1fr)_auto] items-center gap-2.5 bg-card py-2 pr-3"
        >
          <span
            className={cn("self-stretch", alertTones[alert.severity].edge)}
            aria-hidden="true"
          />
          <span
            className={cn(
              "text-center font-mono text-xs font-bold",
              alertTones[alert.severity].icon,
            )}
            aria-hidden="true"
          >
            {alertIcons[alert.kind]}
          </span>
          <span className="flex min-w-0 flex-col gap-px text-sm">
            <b className="font-semibold">{alert.title}</b>
            <span className="text-xs break-words text-muted-foreground">{alert.detail}</span>
          </span>
          <button
            type="button"
            className="border border-border bg-transparent px-2.5 py-1 text-xs font-semibold whitespace-nowrap hover:bg-foreground/[0.06]"
            onClick={() => onShow(alert)}
          >
            {alert.task ? `Show ${alert.task.name}` : "Show"}
          </button>
        </li>
      ))}
    </ul>
  );
}
