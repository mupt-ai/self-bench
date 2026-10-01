import { useEffect, useLayoutEffect, useState } from "react";
import type { EvaluationRun, EvaluationTrial } from "./api";
import type { ConfigurationColumn } from "./configuration-facets";
import type { RunState } from "./ResultsMarks";
import type { Outcome } from "./results-model";

/**
 * What the Results table shows, kept for the browser tab's session so leaving the page and coming
 * back (to a task, a run, or anywhere) finds it as it was: the filter, the open rows, each open
 * batch's result filter and sort, and the scroll position. The open task is in the URL instead.
 */

/** A sort by some column: ascending, or descending. */
export type Order<By extends string> = { by: By; descending: boolean };
export type Sort = Order<"time" | "cost">;

/** The next sort after a click on `by`: ascending, then descending, then back to the default. */
export function nextOrder<By extends string>(order: Order<By> | undefined, by: By) {
  if (order?.by !== by) return { by, descending: false };
  return order.descending ? undefined : { by, descending: true };
}

export interface ResultsView {
  /** The configuration states shown, or all when empty. */
  states: RunState[];
  /** Each configuration facet's chosen values (vendor, provider, …); none chosen shows all. */
  facets: Record<string, string[]>;
  /** The configurations' sort, or most recently run first. */
  order?: Order<ConfigurationColumn>;
  /** Open configurations, by key. */
  configurations: string[];
  /** Open batches, by configuration key and batch id. */
  batches: string[];
  /** Each group's result filter, once changed: the states shown. */
  shown: Record<string, Outcome[]>;
  sorts: Record<string, Sort>;
  /** How many runs each open configuration lists, by key, when more than the first few. */
  runLimits: Record<string, number>;
}

const initial: ResultsView = {
  states: [],
  facets: {},
  configurations: [],
  batches: [],
  shown: {},
  sorts: {},
  runLimits: {},
};

/** Saved facet choices: lists of values, or from before several could be chosen, one value. */
function facetsOf(saved: unknown): Record<string, string[]> {
  if (!saved || typeof saved !== "object") return {};
  return Object.fromEntries(
    Object.entries(saved).map(([facet, values]) => [
      facet,
      (Array.isArray(values) ? values : [values]).filter(
        (value): value is string => typeof value === "string" && value !== "",
      ),
    ]),
  );
}

function restore(key: string): ResultsView {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as Partial<ResultsView> | null;
    if (!saved || typeof saved !== "object") return initial;
    return {
      states: Array.isArray(saved.states) ? saved.states : [],
      facets: facetsOf(saved.facets),
      ...(saved.order && typeof saved.order === "object" ? { order: saved.order } : {}),
      configurations: Array.isArray(saved.configurations) ? saved.configurations : [],
      batches: Array.isArray(saved.batches) ? saved.batches : [],
      shown: saved.shown && typeof saved.shown === "object" ? saved.shown : {},
      sorts: saved.sorts && typeof saved.sorts === "object" ? saved.sorts : {},
      runLimits: saved.runLimits && typeof saved.runLimits === "object" ? saved.runLimits : {},
    };
  } catch {
    return initial;
  }
}

/** The page's scrolling pane, which RepoLayout owns. */
const pane = () => document.querySelector<HTMLElement>('[data-slot="repository-content"]');

/** The table's view for one repository's results, restored from and saved to the session. */
export function useResultsView(url: string) {
  const key = `selfbench-results:${url}`;
  const [view, setView] = useState(() => restore(key));
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(view));
    } catch {}
  }, [key, view]);
  return [view, setView] as const;
}

/**
 * Keeps the pane's scroll position for the session, and puts it back once the table is `ready`:
 * before then the rows it scrolled past aren't there, and the pane can't scroll that far.
 */
export function useScrollMemory(url: string, ready: boolean) {
  const key = `selfbench-results-scroll:${url}`;
  useLayoutEffect(() => {
    const element = pane();
    if (!element || !ready) return;
    try {
      const saved = Number(sessionStorage.getItem(key));
      if (saved > 0) element.scrollTop = saved;
    } catch {}
    let frame = 0;
    const save = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          sessionStorage.setItem(key, String(element.scrollTop));
        } catch {}
      });
    };
    element.addEventListener("scroll", save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", save);
    };
  }, [key, ready]);
}

/** The URL parameter naming the task whose dialog is open: run, source batch, task and harness. */
export const TRIAL_PARAM = "trial";

export function trialParam(run: Pick<EvaluationRun, "id">, trial: EvaluationTrial): string {
  return [run.id, trial.runId, trial.taskId, trial.harness].map(encodeURIComponent).join("/");
}

/** The run and trial a `trial` parameter names, among some runs. */
export function findTrial(
  runs: readonly EvaluationRun[],
  param: string | null,
): { run: EvaluationRun; trial: EvaluationTrial } | undefined {
  if (!param) return undefined;
  const [runId, source, taskId, harness] = param.split("/").map(decodeURIComponent);
  const run = runs.find((entry) => entry.id === runId);
  const trial = run?.trials.find(
    (entry) => entry.runId === source && entry.taskId === taskId && entry.harness === harness,
  );
  return run && trial ? { run, trial } : undefined;
}
