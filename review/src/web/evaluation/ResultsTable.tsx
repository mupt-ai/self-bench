import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { EvaluationRun } from "./api";
import { ColumnHeading, ConfigurationToolbar } from "./ConfigurationFilters";
import {
  type ConfigurationColumn,
  matchingFacets,
  orderedConfigurations,
} from "./configuration-facets";
import type { AcceptedTask } from "./RepoRuns";
import { ConfigurationRows } from "./ResultsConfigurationRows";
import { runStateOf } from "./ResultsMarks";
import { missingTasks } from "./results-coverage";
import { configurationsOf } from "./results-model";
import {
  findTrial,
  nextOrder,
  TRIAL_PARAM,
  trialParam,
  useResultsView,
  useScrollMemory,
} from "./results-view";
import { TrialDialog } from "./TrialDialog";

const flipped = <T,>(list: readonly T[], item: T) =>
  list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];

/**
 * Every configuration, each opening to its runs, each run opening to its tasks. Nothing is
 * open at first; after that the view is kept for the session (`useResultsView`), and the open
 * task's dialog is in the URL, so going back to the page finds it as it was.
 */
export function ResultsTable({
  runs,
  credentials,
  accepted,
  baseUrl,
  repo,
}: {
  runs: readonly EvaluationRun[];
  credentials: readonly CredentialInfo[];
  /** The repository's accepted tasks, for the cumulative results' coverage, once loaded. */
  accepted?: readonly AcceptedTask[];
  baseUrl: string;
  repo: string;
}) {
  const [view, setView] = useResultsView(baseUrl);
  const [search, setSearch] = useSearchParams();
  const configurations = useMemo(() => configurationsOf(runs, credentials), [runs, credentials]);
  useScrollMemory(baseUrl, configurations.length > 0);
  // Escape folds the table up a level at a time: open runs first, then open configurations.
  useEffect(() => {
    const fold = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog or a menu takes Escape for itself.
      if (document.querySelector('dialog[open], [role="menu"]')) return;
      setView((current) => {
        const shownBatches = current.batches.filter((key) =>
          current.configurations.includes(key.split("\n")[0] ?? ""),
        );
        if (shownBatches.length) return { ...current, batches: [] };
        if (current.configurations.length) return { ...current, configurations: [], batches: [] };
        return current;
      });
    };
    document.addEventListener("keydown", fold);
    return () => document.removeEventListener("keydown", fold);
  }, [setView]);
  if (!configurations.length) return null;
  const opened = findTrial(runs, search.get(TRIAL_PARAM));
  const showTrial = (param: string | undefined) =>
    setSearch(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (param) next.set(TRIAL_PARAM, param);
        else next.delete(TRIAL_PARAM);
        return next;
      },
      { replace: true },
    );
  // Facets narrow the table and the state counts; the state toggles then narrow it further.
  const faceted = matchingFacets(configurations, view.facets);
  const states = faceted.map((configuration) => runStateOf(configuration.latest));
  const shown = orderedConfigurations(
    faceted.filter(
      (_, index) => !view.states.length || view.states.includes(states[index] ?? "done"),
    ),
    view.order,
    (configuration) => configuration.latest.length + missingTasks(configuration, accepted).length,
  );
  const sortBy = (column: ConfigurationColumn) =>
    setView((current) => {
      const { order, ...rest } = current;
      const next = nextOrder(order, column);
      return next ? { ...rest, order: next } : rest;
    });
  return (
    <section aria-label="Configurations">
      <h2 className="sr-only">Configurations</h2>
      <ConfigurationToolbar
        configurations={configurations}
        states={states}
        chosenStates={new Set(view.states)}
        onToggleState={(state) =>
          setView((current) => ({ ...current, states: flipped(current.states, state) }))
        }
        chosen={view.facets}
        onToggleFacet={(facet, value) =>
          setView((current) => ({
            ...current,
            facets: { ...current.facets, [facet]: flipped(current.facets[facet] ?? [], value) },
          }))
        }
        onClearFacet={(facet) =>
          setView((current) => {
            const { [facet]: _, ...facets } = current.facets;
            return { ...current, facets };
          })
        }
      />
      {shown.length ? (
        <section
          className="panel min-w-0 overflow-x-auto"
          aria-label="Scrollable Table"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide tables.
          tabIndex={0}
        >
          <table className="w-full min-w-[46rem] table-fixed border-collapse text-left text-sm [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:whitespace-nowrap [&_th]:text-muted-foreground [&_thead]:bg-muted">
            <colgroup>
              <col />
              <col className="w-48" />
              <col className="w-28" />
              <col className="w-36" />
              <col className="w-24" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr>
                <th>Configuration</th>
                <th>Status</th>
                <th>Started By</th>
                {/* Over the counts, not the asterisk beside them. */}
                <ColumnHeading
                  label="Done"
                  column="done"
                  order={view.order}
                  className="pr-[34px]!"
                  onSort={sortBy}
                />
                <ColumnHeading label="Pass Rate" column="pass" order={view.order} onSort={sortBy} />
                <ColumnHeading label="$/Task" column="cost" order={view.order} onSort={sortBy} />
              </tr>
            </thead>
            <tbody>
              {shown.map((configuration) => (
                <ConfigurationRows
                  key={configuration.key}
                  configuration={configuration}
                  accepted={accepted}
                  view={view}
                  setView={setView}
                  onOpenTask={(result) => showTrial(trialParam(result.run, result.trial))}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="panel px-4 py-3 text-sm text-muted-foreground">
          No configurations match this filter.
        </p>
      )}
      {opened && (
        <TrialDialog
          run={opened.run}
          trial={opened.trial}
          showRun
          baseUrl={baseUrl}
          repo={repo}
          onClose={() => showTrial(undefined)}
        />
      )}
    </section>
  );
}
