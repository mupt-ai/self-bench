import { findModel, type ThinkingLevel } from "../../../../src/contracts/models";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import { endpointNumber, publicIds } from "../../../../src/public/endpoint-numbers";
import type { EvaluationRun, EvaluationTrial, Harness } from "./api";

/**
 * The Results page's model: runs grouped by configuration (what a release calls a setting), each
 * configuration's runs by batch (the comparison that started them), and each task's latest
 * result, which is the one that counts.
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

export interface Batch {
  /** The comparison that started it; a run from before comparisons is a batch of its own. */
  id: string;
  createdAt: string;
  startedBy: string;
  runIds: string[];
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
  /** The release's private setting identity, including a custom endpoint. */
  key: string;
  label: string;
  /** The model as its runs name it: "vendor/model", or a custom endpoint's typed name. */
  modelName: string;
  /** Who serves the model: a model provider, OpenRouter, or `custom`. */
  provider: string;
  signIn?: CredentialInfo["auth"];
  harness: Harness;
  thinking?: ThinkingLevel;
  /** A custom model's endpoint, while its credential exists. */
  endpoint?: string;
  /** The "Endpoint N" a release would give it, when another endpoint serves the same setting. */
  endpointNumber?: number;
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

/** The managed model credential has no stored entry; it is OpenRouter with an API key. */
const MANAGED_MODEL = "managed-model";

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
 * src/public/release-results.ts): model, harness, provider, sign-in, reasoning and endpoint. A run
 * whose credential is gone, or that predates recorded credentials, still gets a configuration.
 */
function identityOf(
  run: EvaluationRun,
  harness: Harness,
  credentials: ReadonlyMap<string, CredentialInfo>,
) {
  const credentialId = run.credentials?.modelCredentialId;
  const credential = credentialId ? credentials.get(credentialId) : undefined;
  const custom = run.credentials?.provider === "custom" || run.model === "custom";
  const provider = custom
    ? "custom"
    : (run.credentials?.provider ?? run.modelName.split("/")[0] ?? "");
  // Custom models are recorded as `openai/<typed name>`; the typed name is the identity.
  const typed = custom ? run.modelName.replace(/^openai\//, "") : undefined;
  const model = typed ?? run.model;
  const signIn = credentialId === MANAGED_MODEL ? "api-key" : credential?.auth;
  // A deleted credential's endpoint is gone; its id still keeps its runs apart.
  const endpoint = custom ? (credential?.endpoint ?? `credential:${credentialId ?? ""}`) : "";
  const parts = [model, harness, provider, signIn ?? "unknown", run.thinking ?? "default"];
  return {
    key: JSON.stringify([...parts, endpoint]),
    id: parts.join("|"),
    custom,
    label: typed ?? findModel(run.model)?.label ?? run.modelLabel,
    modelName: typed ?? run.modelName,
    provider,
    harness,
    ...(signIn ? { signIn } : {}),
    ...(run.thinking ? { thinking: run.thinking } : {}),
    ...(custom && credential?.endpoint ? { endpoint: credential.endpoint } : {}),
  };
}
type Identity = ReturnType<typeof identityOf>;

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

function batchesOf(results: readonly TaskResult[]): Batch[] {
  const batches = new Map<string, Batch>();
  for (const result of results) {
    const { run } = result;
    const id = run.comparisonId ?? run.id;
    const batch = batches.get(id) ?? {
      id,
      createdAt: run.createdAt,
      startedBy: run.startedBy,
      runIds: [],
      results: [],
    };
    batches.set(id, batch);
    if (!batch.runIds.includes(run.id)) batch.runIds.push(run.id);
    batch.results.push(result);
  }
  return [...batches.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function configurationOf(identity: Identity, results: TaskResult[], numbers: Map<string, string>) {
  // Results arrive oldest first. Each task's latest usable result counts, as a release takes it;
  // while it has none, its latest of any kind, so errors and running tasks still show.
  const byTask = new Map<string, TaskResult[]>();
  for (const result of results) {
    byTask.set(result.task, [...(byTask.get(result.task) ?? []), result]);
  }
  const counted = [...byTask.values()].flatMap((tried) => {
    const counts = tried.findLast((result) => eligibleTrial(result.trial)) ?? tried.at(-1);
    if (!counts) return [];
    for (const result of tried) if (result !== counts) result.replacedBy = counts;
    return [counts];
  });
  const latest = counted.sort(
    (a, b) => a.trial.taskId.localeCompare(b.trial.taskId) || a.task.localeCompare(b.task),
  );
  const totals = tally(latest);
  const { counts } = totals;
  const number = endpointNumber(numbers.get(identity.key) ?? "");
  const { key, label, modelName, provider, harness, signIn, thinking, endpoint } = identity;
  const configuration: Configuration = {
    key,
    label,
    modelName,
    provider,
    harness,
    ...(signIn ? { signIn } : {}),
    ...(thinking ? { thinking } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(number !== undefined ? { endpointNumber: number } : {}),
    batches: batchesOf(results),
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
  const groups = new Map<string, { identity: Identity; results: TaskResult[] }>();
  const ordered = [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const run of ordered) {
    for (const harness of run.harnesses) {
      const identity = identityOf(run, harness, byId);
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
  // Numbered as a release would number them: among the settings it could publish, which have a
  // known sign-in, an endpoint if custom, and an eligible result.
  const numbers = publicIds(
    [...groups.values()]
      .filter(({ identity }) => identity.signIn && (!identity.custom || identity.endpoint))
      .filter(({ results }) => results.some(({ trial }) => eligibleTrial(trial)))
      .map(({ identity }) => identity),
  );
  const lastStarted = (configuration: Configuration) =>
    configuration.batches.at(-1)?.createdAt ?? "";
  return [...groups.values()]
    .map(({ identity, results }) => configurationOf(identity, results, numbers))
    .sort((a, b) => lastStarted(b).localeCompare(lastStarted(a)) || a.label.localeCompare(b.label));
}
