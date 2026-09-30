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
  | "queued";

export interface TaskResult {
  run: EvaluationRun;
  trial: EvaluationTrial;
  /** The task's key: its source batch and task id. */
  task: string;
  outcome: Outcome;
  /** Why a finished result stays off the chart and out of releases, if it does. */
  wontChart?: string;
  /** Minutes the trial took, or has been running. */
  minutes?: number;
  /** The later result that counts instead of this one. */
  replacedBy?: TaskResult;
  /** The earlier result this one replaced. */
  replaces?: TaskResult;
}

export interface Batch {
  /** The comparison that started it; a run from before comparisons is a batch of its own. */
  id: string;
  createdAt: string;
  startedBy: string;
  runIds: string[];
  results: TaskResult[];
  /** Who cancelled it and when, read from the run. */
  cancelled?: { by: string; at?: string };
}

export interface Configuration {
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
  /** The result that counts for each task, in task order. */
  latest: TaskResult[];
  counts: Record<Outcome, number>;
  /** Tasks whose latest result finished: not running, queued or cancelled. */
  finished: number;
  /** Percent of the scored latest results that passed. */
  passRate?: number;
  /** Mean model cost of the priced latest results. */
  costPerTask?: number;
  /** Model cost of every trial, replaced ones included: what was spent. */
  spend: number;
  status: "running" | "queued" | "done" | "cancelled";
}

/** The managed model credential has no stored entry; it is OpenRouter with an API key. */
const MANAGED_MODEL = "managed-model";

function minutesBetween(from: string | undefined, to: string | number | undefined) {
  if (!from || to === undefined) return undefined;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 60_000 : undefined;
}

function outcomeOf(trial: EvaluationTrial): Outcome {
  if (trial.status === "queued" || trial.status === "running") return trial.status;
  if (trial.status === "failed")
    return /^Cancelled\b/.test(trial.error ?? "") ? "cancelled" : "error";
  const reward = trial.rewards.reward;
  return reward === 1 ? "passed" : reward === 0 ? "failed" : "unscored";
}

/** Why a finished result can't be charted or released (`eligibleTrial`). */
function wontChartReason(trial: EvaluationTrial): string | undefined {
  if (trial.status !== "completed" || eligibleTrial(trial)) return undefined;
  const reward = trial.rewards.reward;
  if (reward !== 0 && reward !== 1) return "Not scored 0 or 1";
  if (trial.modelVerified !== true) return "No verified model usage";
  return "No model cost recorded";
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
});

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
    if (!batch.runIds.includes(run.id)) {
      batch.runIds.push(run.id);
      const by = /^Cancelled by (.+?)\.?$/.exec(run.error ?? "")?.[1];
      if (by) batch.cancelled = { by, ...(run.finishedAt ? { at: run.finishedAt } : {}) };
    }
    batch.results.push(result);
  }
  return [...batches.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function configurationOf(identity: Identity, results: TaskResult[], numbers: Map<string, string>) {
  // Results arrive oldest first, so each task's last one counts.
  const latestByTask = new Map<string, TaskResult>();
  for (const result of results) {
    const earlier = latestByTask.get(result.task);
    if (earlier) {
      earlier.replacedBy = result;
      result.replaces = earlier;
    }
    latestByTask.set(result.task, result);
  }
  const latest = [...latestByTask.values()].sort(
    (a, b) => a.trial.taskId.localeCompare(b.trial.taskId) || a.task.localeCompare(b.task),
  );
  const counts = noOutcomes();
  for (const result of latest) counts[result.outcome] += 1;
  const scored = counts.passed + counts.failed;
  const costs = latest.flatMap(({ trial }) =>
    trial.status === "completed" && typeof trial.apiCostUsd === "number" ? [trial.apiCostUsd] : [],
  );
  const finished = latest.length - counts.running - counts.queued - counts.cancelled;
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
    counts,
    finished,
    ...(scored ? { passRate: (counts.passed / scored) * 100 } : {}),
    ...(costs.length
      ? { costPerTask: costs.reduce((sum, cost) => sum + cost, 0) / costs.length }
      : {}),
    spend: results.reduce((sum, { trial }) => sum + (trial.apiCostUsd ?? 0), 0),
    status:
      counts.running > 0 || (counts.queued > 0 && finished > 0)
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
        const reason = wontChartReason(trial);
        const end = trial.finishedAt ?? (trial.status === "running" ? now : undefined);
        const minutes = minutesBetween(trial.startedAt, end);
        group.results.push({
          run,
          trial,
          task: `${trial.runId}/${trial.taskId}`,
          outcome: outcomeOf(trial),
          ...(reason ? { wontChart: reason } : {}),
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
