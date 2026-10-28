import { Sparkles } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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
 * Model Summaries: a button in the Results page's actions that opens, for the configurations
 * chosen in it as the chart's are chosen, what each does well and where it fails, written by a
 * model from its scored results; and asks for new ones through a saved key and model.
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
  const summaries = useMemo(
    () => new Map(state?.summaries.map((summary) => [summary.configuration, summary])),
    [state],
  );
  const failures = useMemo(
    () => new Map(state?.failures.map((failure) => [failure.configuration, failure])),
    [state],
  );
  if (!signedIn || !options.length) return null;
  return (
    <>
      <button
        type="button"
        className={buttonStyles.secondary}
        onClick={() => setOpen(true)}
        title="What each model does well and where it fails"
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
            description="What each chosen configuration does well and where it fails, written by a model from its scored results and failure explanations on the accepted tasks."
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
                  ? "Each is summarized from its own scored results on the accepted tasks."
                  : "Choose configurations to summarize."
              }
              legend="Configurations to Summarize"
              choose={choose}
            />
            {state?.available === false
              ? state.reason && <p className="text-sm text-muted-foreground">{state.reason}</p>
              : chosen.length > 0 && (
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
                )}
            {error && <Notice>{error}</Notice>}
            {chosen.length > 0 && (
              <ul className="divide-y divide-border panel">
                {chosen.map((option) => {
                  const { configuration } = option;
                  const summary = summaries.get(configuration.key);
                  const failure = failures.get(configuration.key);
                  const busy = running.includes(configuration.key);
                  const now = scored(option);
                  const changed =
                    summary && (summary.tasks !== now.tasks || summary.passed !== now.passed);
                  return (
                    <li key={configuration.key} className="min-w-0 space-y-2 px-4 py-3">
                      <ConfigurationName configuration={configuration} />
                      {busy ? (
                        <p role="status" className="text-sm text-muted-foreground">
                          Summarizing…
                        </p>
                      ) : (
                        <>
                          {summary && (
                            <>
                              <p className="text-sm leading-6">{summary.text}</p>
                              <p className="text-xs text-muted-foreground">
                                {summary.model} read {summary.tasks} scored{" "}
                                {summary.tasks === 1 ? "task" : "tasks"}, {summary.passed} passed ·{" "}
                                {momentLabel(summary.summarizedAt)}
                                {changed && " · Its results have changed since"}
                              </p>
                            </>
                          )}
                          {failure ? (
                            <p className="text-sm text-destructive">
                              The last summary failed: {failure.message}
                            </p>
                          ) : (
                            !summary && (
                              <p className="text-sm text-muted-foreground">Not summarized yet.</p>
                            )
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
