import type { SettingResults } from "../public/release-results.js";
import { costTotal } from "./cost-total.js";
import type { SummaryTask } from "./model-summary.js";
import { configurationName } from "./model-summary-material.js";
import { evaluationTaskKey, type Harness } from "./models.js";

/** One configuration's score on the tasks results count on. */
interface ConfigurationResult {
  /** The setting key that model summaries and releases name it by. */
  key: string;
  name: string;
  model: string;
  harness: Harness;
  reasoning: string;
  /** Tasks it has a scored result on, and how many of those passed. */
  scored: number;
  passed: number;
  /** Percent of its scored tasks it passed. */
  passRate: number;
  costPerTaskUsd?: number;
}

/** One configuration's latest scored result on one task. */
interface TrialResult {
  configuration: string;
  passed: boolean;
  /** The evaluation and harness that ran it, which explaining its failure names. */
  evaluationId: string;
  harness: Harness;
  costUsd?: number;
  /** Why it failed its tests, once explained. */
  failureSummary?: string;
}

export interface TaskResults {
  runId: string;
  taskId: string;
  difficulty?: string;
  scored: number;
  passed: number;
  results: TrialResult[];
}

/**
 * A variant's latest scored result per configuration, reported beside the task it changes and
 * never counted with the tasks: the condition a comparison of the two measures.
 */
export interface VariantResults extends TaskResults {
  label: string;
  of: { runId: string; taskId: string };
}

/** What the Results page shows, as data: each configuration's score and each task's results. */
export interface ResultsReport {
  /** Tasks results count on: a repository's accepted tasks, or a benchmark's. */
  tasks: number;
  configurations: ConfigurationResult[];
  taskResults: TaskResults[];
  /** The tasks' variants with a scored result, by the task they change. */
  variants?: VariantResults[];
}

/** Each variant's results, as resultsReport gives a task's; variants with none are left out. */
export function variantResults(
  settings: ReadonlyMap<string, SettingResults>,
  variants: readonly (Pick<SummaryTask, "runId" | "taskId" | "difficulty"> & {
    label: string;
    of: { runId: string; taskId: string };
  })[],
): VariantResults[] {
  const byKey = new Map(
    variants.map((variant) => [evaluationTaskKey(variant.runId, variant.taskId), variant]),
  );
  return resultsReport(settings, variants).taskResults.flatMap((results) => {
    const variant = byKey.get(evaluationTaskKey(results.runId, results.taskId));
    return variant && results.scored > 0
      ? [{ ...results, label: variant.label, of: variant.of }]
      : [];
  });
}

/**
 * The report for settings already narrowed to the counted tasks (`summarizable`), which take each
 * task's latest scored result, as the chart, model summaries and releases do. Configurations sort
 * by pass rate, best first; tasks by how many configurations passed them, fewest first.
 */
export function resultsReport(
  settings: ReadonlyMap<string, SettingResults>,
  tasks: readonly Pick<SummaryTask, "runId" | "taskId" | "difficulty">[],
): ResultsReport {
  const configurations: ConfigurationResult[] = [];
  const byTask = new Map<string, TrialResult[]>();
  for (const { setting, results } of settings.values()) {
    const trials = [...results.values()].map((result) => result.trial);
    const passed = trials.filter((trial) => trial.rewards.reward === 1).length;
    const { perTask } = costTotal(trials);
    configurations.push({
      key: setting.key,
      name: configurationName(setting),
      model: setting.modelName,
      harness: setting.harness,
      reasoning: setting.reasoningLevel,
      scored: trials.length,
      passed,
      passRate: trials.length ? (passed / trials.length) * 100 : 0,
      ...(perTask !== undefined ? { costPerTaskUsd: perTask } : {}),
    });
    for (const [task, { trial, run }] of results) {
      const list = byTask.get(task) ?? [];
      byTask.set(task, list);
      list.push({
        configuration: setting.key,
        passed: trial.rewards.reward === 1,
        evaluationId: run.id,
        harness: trial.harness,
        ...(trial.apiCostUsd !== undefined ? { costUsd: trial.apiCostUsd } : {}),
        ...(trial.failureSummary ? { failureSummary: trial.failureSummary.text } : {}),
      });
    }
  }
  const taskResults = tasks.map(({ runId, taskId, difficulty }) => {
    const results = byTask.get(evaluationTaskKey(runId, taskId)) ?? [];
    return {
      runId,
      taskId,
      ...(difficulty ? { difficulty } : {}),
      scored: results.length,
      passed: results.filter((result) => result.passed).length,
      results,
    };
  });
  const passShare = (task: TaskResults) => (task.scored ? task.passed / task.scored : 1);
  return {
    tasks: tasks.length,
    configurations: configurations.sort(
      (a, b) => b.passRate - a.passRate || a.name.localeCompare(b.name),
    ),
    taskResults: taskResults.sort(
      (a, b) => passShare(a) - passShare(b) || a.taskId.localeCompare(b.taskId),
    ),
  };
}
