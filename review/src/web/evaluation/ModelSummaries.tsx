import { Sparkles } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { MAX_SUMMARY_CONFIGURATIONS } from "../../../../src/contracts/model-summary-limit";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import { Dialog, DialogHeader } from "../Dialog";
import { useSession } from "../session";
import { buttonStyles, Notice } from "../ui";
import { ChartConfigurations, useChosen } from "./ChartConfigurations";
import { useChartOptions } from "./ChartPreview";
import { FailureExplanationForm } from "./FailureExplanationForm";
import { ConfigurationName } from "./ResultsMarks";
import { type ChartOption, chosenOptions } from "./results-chart";
import { momentLabel } from "./results-presentation";
import { useModelSummaries } from "./useModelSummaries";

const LABELS = { action: "Summarize Models", busy: "Summarizing…", model: "Summary Model" };

/** A configuration's scored tasks now, and how many passed, to tell whether its summary is stale. */
function scored({ configuration, coverage }: ChartOption) {
  const passed = configuration.latest.filter(
    (result) =>
      coverage.has(result.task) && eligibleTrial(result.trial) && result.trial.rewards.reward === 1,
  ).length;
  return { tasks: coverage.size, passed };
}

/**
 * Model Summaries: a button in the Results page's actions that opens the latest report, in which one
 * model compared configurations chosen as the chart's are, and asks for another through a saved
 * key and model.
 */
export function ModelSummaries() {
  const { session } = useSession();
  const { url, tasks, options } = useChartOptions();
  const close = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saved, choose] = useChosen(url, "summary");
  const chosen = useMemo(() => chosenOptions(options, saved), [options, saved]);
  const signedIn = session.status === "signed-in";
  const { state, running, writing, error, summarize } = useModelSummaries({
    baseUrl: url,
    enabled: open && signedIn,
  });
  const report = state?.report;
  const offered = useMemo(
    () => new Map(options.map((option) => [option.configuration.key, option])),
    [options],
  );
  const covered = new Set(report?.summaries.map((summary) => summary.configuration));
  const uncovered = chosen.filter((option) => !covered.has(option.configuration.key)).length;
  if (!signedIn || !options.length) return null;
  return (
    <>
      <button
        type="button"
        className={buttonStyles.secondary}
        onClick={() => setOpen(true)}
        title="Which model to give which kind of work"
      >
        <Sparkles aria-hidden="true" />
        Model Summaries
      </button>
      {open && (
        <Dialog
          initialFocus={close}
          onDismiss={() => setOpen(false)}
          size="wide"
          aria-labelledby="model-summaries-title"
          // The app's dialogs ignore Escape (closedby="none"); this one closes on it.
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <DialogHeader
            title="Model Summaries"
            titleId="model-summaries-title"
            description="One model reads the chosen configurations' results and writes routing advice: which to trust with what, then for each the work to send it, the work to avoid or review, and how it fails."
            onClose={() => setOpen(false)}
            closeRef={close}
          />
          <div className="min-w-0 space-y-4 p-4 sm:p-6">
            <ChartConfigurations
              options={options}
              tasks={tasks.length}
              chosen={chosen}
              custom={saved !== undefined}
              summary={
                chosen.length
                  ? "One model compares them all, from their scored results on the accepted tasks."
                  : "Choose configurations to summarize."
              }
              legend="Configurations to Summarize"
              choose={choose}
            />
            {state?.available === false ? (
              state.reason && <p className="text-sm text-muted-foreground">{state.reason}</p>
            ) : chosen.length > MAX_SUMMARY_CONFIGURATIONS ? (
              <p className="text-sm text-muted-foreground">
                Choose at most {MAX_SUMMARY_CONFIGURATIONS} configurations to compare;{" "}
                {chosen.length} are chosen.
              </p>
            ) : (
              chosen.length > 0 && (
                <FailureExplanationForm
                  baseUrl={url}
                  explaining={writing}
                  onExplain={(selection) =>
                    summarize(
                      chosen.map((option) => option.configuration.key),
                      selection,
                    )
                  }
                  labels={LABELS}
                />
              )
            )}
            {error && <Notice>{error}</Notice>}
            {writing ? (
              <p role="status" className="text-sm text-muted-foreground">
                Comparing {running.length}{" "}
                {running.length === 1 ? "configuration" : "configurations"}…
              </p>
            ) : (
              state?.failure && (
                <p className="text-sm text-destructive">
                  The last summary failed: {state.failure.message}
                </p>
              )
            )}
            {report ? (
              <section aria-labelledby="model-summaries-report" className="space-y-3">
                <div className="space-y-1.5">
                  <h3 id="model-summaries-report" className="text-sm font-semibold">
                    Overall
                  </h3>
                  {report.overview && <p className="text-sm leading-6">{report.overview}</p>}
                  <p className="text-xs text-muted-foreground">
                    {report.model} compared {report.summaries.length}{" "}
                    {report.summaries.length === 1 ? "configuration" : "configurations"} ·{" "}
                    {momentLabel(report.summarizedAt)}
                    {uncovered > 0 &&
                      ` · ${uncovered} of the chosen ${uncovered === 1 ? "is" : "are"} not in it; summarize again to include ${uncovered === 1 ? "it" : "them"}`}
                  </p>
                </div>
                <ul className="divide-y divide-border panel">
                  {report.summaries.map((summary) => {
                    const option = offered.get(summary.configuration);
                    const now = option && scored(option);
                    const changed =
                      now && (summary.tasks !== now.tasks || summary.passed !== now.passed);
                    return (
                      <li key={summary.configuration} className="min-w-0 space-y-2 px-4 py-3">
                        {option ? (
                          <ConfigurationName configuration={option.configuration} />
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">
                            {summary.configuration}
                          </span>
                        )}
                        <p className="text-sm leading-6">{summary.text}</p>
                        <p className="text-xs text-muted-foreground">
                          From {summary.tasks} scored {summary.tasks === 1 ? "task" : "tasks"},{" "}
                          {summary.passed} passed
                          {changed && " · Its results have changed since"}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : (
              !writing &&
              state && <p className="text-sm text-muted-foreground">Nothing summarized yet.</p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
