import { findModel, models, type ThinkingLevel } from "../contracts/models.js";
import { eligibleTrial } from "../evaluation/eligible.js";
import { evaluationTaskKey, type Harness } from "../evaluation/models.js";
import type { EvaluationRun, EvaluationTrial } from "../evaluation/types.js";
import { findListedModel, isGateway } from "../gateways/index.js";
import type { ReleaseProvider, ReleaseSignIn } from "./release-types.js";

/**
 * A setting is model, harness, and reasoning level. Its result on each task is the latest
 * eligible trial across all credential routes and custom endpoints in the repository.
 */

/** The credential fields a setting needs. Deleted credentials still resolve old runs. */
export interface CredentialFacts {
  auth: ReleaseSignIn;
  endpoint?: string;
}

/** The managed model credential has no stored entry; it is OpenRouter with an API key. */
const MANAGED_MODEL = "managed-model";

export interface Setting {
  /** Stable identity across provider, sign-in, and endpoint changes. */
  key: string;
  /** Public identity of this model, harness, and reasoning level. */
  id: string;
  catalogId: string;
  modelName: string;
  label: string;
  harness: Harness;
  reasoningLevel: ThinkingLevel;
  provider: ReleaseProvider;
  custom: boolean;
}

/** The setting a run's trials on `harness` belong to, or undefined when it cannot resolve. */
function settingOf(
  run: EvaluationRun,
  harness: Harness,
  credentials: ReadonlyMap<string, CredentialFacts>,
): Setting | undefined {
  if (!run.credentials) return undefined;
  const credentialId = run.credentials.modelCredentialId;
  if (credentialId !== MANAGED_MODEL && !credentials.has(credentialId)) return undefined;
  const custom = run.credentials.provider === "custom";
  // Curated models use one id on their direct provider and another on the gateways.
  const catalog =
    findModel(run.model) ??
    (isGateway(run.credentials.provider)
      ? models.find((model) => model.openRouter === run.model)
      : undefined);
  const typed = custom ? run.modelName.replace(/^openai\//, "") : undefined;
  const model = custom ? `custom/${typed}` : (catalog?.id ?? run.model);
  const reasoningLevel = run.thinking ?? "default";
  const parts = [model, harness, reasoningLevel];
  return {
    key: JSON.stringify(parts),
    id: parts.join("|"),
    catalogId: custom ? "custom" : (catalog?.id ?? run.model),
    modelName: typed ?? (catalog?.vendor ? `${catalog.vendor}/${catalog.id}` : run.modelName),
    label: typed ?? catalog?.label ?? findListedModel(run.model)?.label ?? run.modelLabel,
    harness,
    reasoningLevel,
    // This describes the model's vendor, not the credential route of a selected trial.
    provider: custom ? "custom" : (catalog?.vendor ?? run.credentials.provider),
    custom,
  };
}

/** The trial chosen for one setting on one task, with where it came from. */
interface Result {
  trial: EvaluationTrial;
  run: EvaluationRun;
  index: number;
}

/** A setting with its chosen result per task key. */
export interface SettingResults {
  setting: Setting;
  results: Map<string, Result>;
}

/** Later sorts after: finished time, run created time, run id, position. */
function later(left: Result, right: Result): boolean {
  const order = (result: Result) => [
    result.trial.finishedAt ?? "",
    result.run.createdAt,
    result.run.id,
    String(result.index).padStart(8, "0"),
  ];
  const [a, b] = [order(left), order(right)];
  for (let position = 0; position < a.length; position += 1) {
    const [x = "", y = ""] = [a[position], b[position]];
    if (x !== y) return x > y;
  }
  return false;
}

/** Every setting's latest eligible result per task, keyed by setting key. */
export function resultsBySetting(
  runs: readonly EvaluationRun[],
  credentials: ReadonlyMap<string, CredentialFacts>,
): Map<string, SettingResults> {
  const bySetting = new Map<string, SettingResults>();
  for (const run of runs) {
    for (const [index, trial] of run.trials.entries()) {
      if (!eligibleTrial(trial)) continue;
      const setting = settingOf(run, trial.harness, credentials);
      if (!setting) continue;
      const entry = bySetting.get(setting.key) ?? { setting, results: new Map() };
      bySetting.set(setting.key, entry);
      const taskKey = evaluationTaskKey(trial.runId, trial.taskId);
      const candidate = { trial, run, index };
      const current = entry.results.get(taskKey);
      if (!current || later(candidate, current)) entry.results.set(taskKey, candidate);
    }
  }
  return bySetting;
}
