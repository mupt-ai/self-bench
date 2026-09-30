import { type ReactNode, useMemo, useState } from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { cn } from "../primitives/cn";
import { SectionHeader } from "../ui";
import type { EvaluationRun } from "./api";
import { ResultsAlerts, ResultsSummary } from "./ResultsSummary";
import { ResultsTable, rowId } from "./ResultsTable";
import { type Alert, needsAttention, type Review, reviewOf } from "./results-alerts";
import { type Configuration, configurationsOf } from "./results-model";

type Filter = "all" | "attention" | "running" | "queued" | "done" | "cancelled";

const filters: [Filter, string, (configuration: Configuration, review: Review) => boolean][] = [
  ["all", "All", () => true],
  [
    "attention",
    "Needs Attention",
    (configuration, review) => needsAttention(review, configuration),
  ],
  ["running", "Running", (configuration) => configuration.status === "running"],
  ["queued", "Queued", (configuration) => configuration.status === "queued"],
  ["done", "Done", (configuration) => configuration.status === "done"],
  ["cancelled", "Cancelled", (configuration) => configuration.status === "cancelled"],
];

/** Configurations open until someone closes them: the first few that need attention. */
const OPEN_AT_FIRST = 3;

const toggled = (set: ReadonlySet<string>, key: string, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};

/**
 * The Results page's status and table: a summary, the alerts, then (after `children`, the chart)
 * every configuration with its batches and tasks. Alerts' Show buttons steer the table.
 */
export function ResultsOverview({
  runs,
  credentials,
  onOpenRun,
  children,
}: {
  runs: readonly EvaluationRun[];
  credentials: readonly CredentialInfo[];
  onOpenRun(runId: string): void;
  children?: ReactNode;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<NonNullable<Alert["task"]>>();
  const [highlight, setHighlight] = useState<string>();
  // Runs refresh every few seconds while any is unfinished, which re-renders with a fresh time.
  const { configurations, review } = useMemo(() => {
    const now = Date.now();
    const configurations = configurationsOf(runs, credentials, now);
    return { configurations, review: reviewOf(configurations, now) };
  }, [runs, credentials]);
  const firstOpen = new Set(
    configurations
      .filter((configuration) => needsAttention(review, configuration))
      .slice(0, OPEN_AT_FIRST)
      .map((configuration) => configuration.key),
  );
  const open = new Set(
    configurations
      .map((configuration) => configuration.key)
      .filter((key) => opened.has(key) || (firstOpen.has(key) && !closed.has(key))),
  );
  const shown = focus
    ? configurations.filter((configuration) => focus.configurations.includes(configuration.key))
    : configurations.filter((configuration) =>
        (filters.find(([key]) => key === filter)?.[2] ?? (() => true))(configuration, review),
      );
  const setOpen = (key: string, on: boolean) => {
    setOpened((set) => toggled(set, key, on));
    setClosed((set) => toggled(set, key, !on));
  };
  const show = (alert: Alert) => {
    setFilter("all");
    if (alert.task) {
      setFocus(alert.task);
      setHighlight(undefined);
      for (const key of alert.task.configurations) setOpen(key, true);
      return;
    }
    if (!alert.configuration) return;
    const key = alert.configuration;
    setFocus(undefined);
    setHighlight(key);
    setOpen(key, true);
    requestAnimationFrame(() =>
      document
        .getElementById(rowId(configurations, key))
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  };
  return (
    <>
      {configurations.length > 0 && (
        <>
          <ResultsSummary configurations={configurations} review={review} />
          <ResultsAlerts alerts={review.alerts} onShow={show} />
        </>
      )}
      {children}
      {configurations.length > 0 && (
        <section className="mt-8" aria-label="Configurations">
          <SectionHeader title="Configurations">
            <fieldset className="flex min-w-0 flex-wrap gap-1.5">
              <legend className="sr-only">Filter Configurations</legend>
              {filters.map(([key, label, test]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={!focus && filter === key}
                  className={cn(
                    "inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-xs font-semibold hover:bg-foreground/[0.06]",
                    !focus &&
                      filter === key &&
                      "border-foreground bg-foreground text-background hover:bg-foreground",
                  )}
                  onClick={() => {
                    setFilter(key);
                    setFocus(undefined);
                    setHighlight(undefined);
                  }}
                >
                  {label}
                  <span className="font-mono font-normal tabular-nums opacity-75">
                    {configurations.filter((configuration) => test(configuration, review)).length}
                  </span>
                </button>
              ))}
            </fieldset>
          </SectionHeader>
          {focus && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-dashed border-destructive px-3 py-2 text-sm">
              <span>
                Showing <b className="font-semibold">{focus.name}</b> on the {shown.length}{" "}
                configurations where it errored.
              </span>
              <button
                type="button"
                className="border border-border px-2.5 py-1 text-xs font-semibold hover:bg-foreground/[0.06]"
                onClick={() => setFocus(undefined)}
              >
                Show Everything
              </button>
            </div>
          )}
          {shown.length ? (
            <ResultsTable
              configurations={shown}
              all={configurations}
              review={review}
              view={{
                open,
                showAll,
                ...(focus ? { focusTask: focus.key } : {}),
                ...(highlight ? { highlight } : {}),
              }}
              onToggle={(key) => setOpen(key, !open.has(key))}
              onShowAll={(key, on) => setShowAll((set) => toggled(set, key, on))}
              onOpenRun={onOpenRun}
            />
          ) : (
            <p className="panel px-4 py-3 text-sm text-muted-foreground">
              No configurations match this filter.
            </p>
          )}
        </section>
      )}
    </>
  );
}
