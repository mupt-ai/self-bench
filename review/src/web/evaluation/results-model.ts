import { findModel, models, type ThinkingLevel } from "../../../../src/contracts/models";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import { findListedModel, isGateway } from "../../../../src/gateways";
import type { EvaluationRun, EvaluationTrial, Harness } from "./api";
import { routeLabel } from "./results-presentation";

/**
 * The Results page's model: runs grouped by configuration (what a release calls a setting: model,
 * harness and reasoning, whatever route reached the model), each configuration's runs, and each
 * task's latest result, which is the one that counts.
 */

export type Outcome =
  | "passed"
  | "failed"
  | "unscored"
  | "error"
  | "cancelled"
  | "running"
  | "queued"
  /**
   * Accepted tasks the configuration has no result for, in the coverage view only: one accepted
   * before its last run that the run left out, or one accepted since.
   */
  | "unrun"
  | "added";

export interface TaskResult {
  run: EvaluationRun;
  trial: EvaluationTrial;
  /** The task's key: its source batch and task id. */
  task: string;
  outcome: Outcome;
  /** Minutes the trial took, or has been running. */
  minutes?: number;
  /** The task's result that counts instead of this one: a later one, or an earlier usable one. */
  replacedBy?: TaskResult;
}

/**
 * One run of a configuration and its results. A comparison that ran the configuration twice, by
 * two routes, has two.
 */
export interface Batch {
  /** The run's id. */
  id: string;
  createdAt: string;
  startedBy: string;
  /** How the run reached the model. */
  route: string;
  results: TaskResult[];
}

/** Outcome counts, and what they add up to, for a configuration's or a batch's results. */
export interface Tally {
  counts: Record<Outcome, number>;
  /** Tasks that finished: not running, queued or cancelled. */
  finished: number;
  /** Percent of the scored results that passed. */
  passRate?: number;
  /** Mean model cost of the priced results. */
  costPerTask?: number;
}

export interface Configuration extends Tally {
  /** The release's setting key: model, harness and reasoning. */
  key: string;
  label: string;
  /** The model as a release names it: "vendor/model", or a custom endpoint's typed name. */
  modelName: string;
  /** The model's vendor, or `custom`; a model the catalog doesn't know keeps its route's provider. */
  provider: string;
  harness: Harness;
  thinking?: ThinkingLevel;
  /** How its runs reached the model, in the order they were first used. */
  routes: string[];
  /** Oldest first. */
  batches: Batch[];
  /**
   * The result that counts for each task, in task order: its latest usable one, as a release takes
   * it, or while it has none, its latest of any kind.
   */
  latest: TaskResult[];
  /** Tasks being run again whose result that counts is an earlier one: still under way. */
  underway: TaskResult[];
  status: "running" | "queued" | "done" | "cancelled";
}

/**
 * A result under way: running, or queued in a run that has started, which may still be preparing
 * its sandboxes and task images.
 */
function inProgress(result: TaskResult): boolean {
  return (
    result.outcome === "running" || (result.outcome === "queued" && result.run.status === "running")
  );
}

function minutesBetween(from: string | undefined, to: string | number | undefined) {
  if (!from || to === undefined) return undefined;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 60_000 : undefined;
}

export function outcomeOf(trial: EvaluationTrial): Outcome {
  if (trial.status === "queued" || trial.status === "running") return trial.status;
  if (trial.status === "failed")
    return /^Cancelled\b/.test(trial.error ?? "") ? "cancelled" : "error";
  const reward = trial.rewards.reward;
  return reward === 1 ? "passed" : reward === 0 ? "failed" : "unscored";
}

/**
 * The release's setting for a run's trials on one harness (settingOf in
 * src/public/release-results.ts): model, harness and reasoning, whatever route reached the model.
 * A run from before runs recorded their credentials has none, and is left out, as a release
 * leaves it out.
 */
function identityOf(run: EvaluationRun, harness: Harness) {
  if (!run.credentials) return undefined;
  const custom = run.credentials.provider === "custom";
  // Curated models use one id on their direct provider and another on the gateways.
  const catalog =
    findModel(run.model) ??
    (isGateway(run.credentials.provider)
      ? models.find((model) => model.openRouter === run.model)
      : undefined);
  // Custom models are recorded as `openai/<typed name>`; the typed name is the identity.
  const typed = custom ? run.modelName.replace(/^openai\//, "") : undefined;
  const model = custom ? `custom/${typed}` : (catalog?.id ?? run.model);
  return {
    key: JSON.stringify([model, harness, run.thinking ?? "default"]),
    label: typed ?? catalog?.label ?? findListedModel(run.model)?.label ?? run.modelLabel,
    modelName: typed ?? (catalog?.vendor ? `${catalog.vendor}/${catalog.id}` : run.modelName),
    provider: custom ? "custom" : (catalog?.vendor ?? run.credentials.provider),
    harness,
    ...(run.thinking ? { thinking: run.thinking } : {}),
  };
}
type Identity = NonNullable<ReturnType<typeof identityOf>>;

const noOutcomes = (): Record<Outcome, number> => ({
  passed: 0,
  failed: 0,
  unscored: 0,
  error: 0,
  cancelled: 0,
  running: 0,
  queued: 0,
  unrun: 0,
  added: 0,
});

/** Counts, finished tasks, pass rate and cost per task of some results. */
export function tally(results: readonly TaskResult[]): Tally {
  const counts = noOutcomes();
  for (const result of results) counts[result.outcome] += 1;
  const scored = counts.passed + counts.failed;
  const costs = results.flatMap(({ trial }) =>
    trial.status === "completed" && typeof trial.apiCostUsd === "number" ? [trial.apiCostUsd] : [],
  );
  return {
    counts,
    finished: results.length - counts.running - counts.queued - counts.cancelled,
    ...(scored ? { passRate: (counts.passed / scored) * 100 } : {}),
    ...(costs.length
      ? { costPerTask: costs.reduce((sum, cost) => sum + cost, 0) / costs.length }
      : {}),
  };
}

function batchesOf(
  results: readonly TaskResult[],
  routeOf: (run: EvaluationRun) => string,
): Batch[] {
  const batches = new Map<string, Batch>();
  for (const result of results) {
    const { run } = result;
    const batch = batches.get(run.id) ?? {
      id: run.id,
      createdAt: run.createdAt,
      startedBy: run.startedBy,
      route: routeOf(run),
      results: [],
    };
    batches.set(run.id, batch);
    batch.results.push(result);
  }
  return [...batches.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/**
 * Whether a usable result is later than another, as a release orders them (later in
 * src/public/release-results.ts): by when it finished, then its run's start, run id and place.
 */
function later(left: TaskResult, right: TaskResult): boolean {
  const order = ({ run, trial }: TaskResult) => [
    trial.finishedAt ?? "",
    run.createdAt,
    run.id,
    String(run.trials.indexOf(trial)).padStart(8, "0"),
  ];
  const [a, b] = [order(left), order(right)];
  for (let position = 0; position < a.length; position += 1) {
    const [x = "", y = ""] = [a[position], b[position]];
    if (x !== y) return x > y;
  }
  return false;
}

function configurationOf(
  identity: Identity,
  results: TaskResult[],
  routeOf: (run: EvaluationRun) => string,
) {
  // Results arrive oldest first. Each task's latest usable result counts, as a release takes it;
  // while it has none, its latest of any kind, so errors and running tasks still show.
  const byTask = new Map<string, TaskResult[]>();
  for (const result of results) {
    byTask.set(result.task, [...(byTask.get(result.task) ?? []), result]);
  }
  const counted = [...byTask.values()].flatMap((tried) => {
    const usable = tried
      .filter((result) => eligibleTrial(result.trial))
      .reduce<TaskResult | undefined>(
        (best, result) => (!best || later(result, best) ? result : best),
        undefined,
      );
    const counts = usable ?? tried.at(-1);
    if (!counts) return [];
    for (const result of tried) if (result !== counts) result.replacedBy = counts;
    return [counts];
  });
  const latest = counted.sort(
    (a, b) => a.trial.taskId.localeCompare(b.trial.taskId) || a.task.localeCompare(b.task),
  );
  const totals = tally(latest);
  const { counts } = totals;
  const batches = batchesOf(results, routeOf);
  const configuration: Configuration = {
    ...identity,
    routes: [...new Set(batches.map((batch) => batch.route))],
    batches,
    latest,
    ...totals,
    underway: results.filter((result) => result.replacedBy && inProgress(result)),
    status: results.some(inProgress)
      ? "running"
      : counts.queued > 0
        ? "queued"
        : counts.cancelled > 0
          ? "cancelled"
          : "done",
  };
  return configuration;
}

/** Every configuration in the runs, the most recently started first. */
export function configurationsOf(
  runs: readonly EvaluationRun[],
  credentials: readonly CredentialInfo[],
  now: number = Date.now(),
): Configuration[] {
  const byId = new Map(credentials.map((credential) => [credential.id, credential]));
  const routeOf = (run: EvaluationRun) =>
    routeLabel(run, byId.get(run.credentials?.modelCredentialId ?? ""));
  const groups = new Map<string, { identity: Identity; results: TaskResult[] }>();
  const ordered = [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const run of ordered) {
    for (const harness of run.harnesses) {
      const identity = identityOf(run, harness);
      if (!identity) continue;
      const group = groups.get(identity.key) ?? { identity, results: [] };
      groups.set(identity.key, group);
      for (const trial of run.trials) {
        if (trial.harness !== harness) continue;
        const end = trial.finishedAt ?? (trial.status === "running" ? now : undefined);
        const minutes = minutesBetween(trial.startedAt, end);
        group.results.push({
          run,
          trial,
          task: `${trial.runId}/${trial.taskId}`,
          outcome: outcomeOf(trial),
          ...(minutes !== undefined ? { minutes } : {}),
        });
      }
    }
  }
  const lastStarted = (configuration: Configuration) =>
    configuration.batches.at(-1)?.createdAt ?? "";
  return [...groups.values()]
    .map(({ identity, results }) => configurationOf(identity, results, routeOf))
    .sort((a, b) => lastStarted(b).localeCompare(lastStarted(a)) || a.label.localeCompare(b.label));
}
