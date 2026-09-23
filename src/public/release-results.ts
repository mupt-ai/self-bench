import { findModel, type ThinkingLevel } from "../contracts/models.js";
import { eligibleTrial } from "../evaluation/eligible.js";
import { evaluationTaskKey, type Harness } from "../evaluation/models.js";
import type { EvaluationRun, EvaluationTrial } from "../evaluation/types.js";
import { sha256 } from "../lib/hash.js";
import type { ReleaseProvider, ReleaseSignIn } from "./release-types.js";

/**
 * Settings and results. A setting is model, harness, provider, sign-in type, reasoning level,
 * and endpoint. A result is the latest eligible trial of a setting on a task, across every run
 * of the repository.
 */

/** The credential fields a setting needs. Deleted credentials still resolve old runs. */
export interface CredentialFacts {
  auth: ReleaseSignIn;
  endpoint?: string;
}

/** The managed model credential has no stored entry; it is OpenRouter with an API key. */
const MANAGED_MODEL = "managed-model";

export interface Setting {
  /** Private identity, including a custom endpoint. Stable and unambiguous. */
  key: string;
  /** Public identity: the same, with a custom endpoint replaced by a short digest. */
  id: string;
  catalogId: string;
  modelName: string;
  label: string;
  harness: Harness;
  reasoningLevel: ThinkingLevel;
  provider: ReleaseProvider;
  signIn: ReleaseSignIn;
  custom: boolean;
  endpoint?: string;
}

/** The setting a run's trials on `harness` belong to, or undefined when it cannot resolve. */
function settingOf(
  run: EvaluationRun,
  harness: Harness,
  credentials: ReadonlyMap<string, CredentialFacts>,
): Setting | undefined {
  if (!run.credentials) return undefined;
  const credentialId = run.credentials.modelCredentialId;
  const credential: CredentialFacts | undefined =
    credentialId === MANAGED_MODEL ? { auth: "api-key" } : credentials.get(credentialId);
  if (!credential) return undefined;
  const provider = run.credentials.provider;
  const custom = provider === "custom";
  // Custom models are recorded as `openai/<typed name>`; the typed name is the identity.
  const typed = custom ? run.modelName.replace(/^openai\//, "") : undefined;
  const catalogId = run.model;
  const model = typed ?? catalogId;
  const endpoint = custom ? (credential.endpoint ?? "") : "";
  const reasoningLevel = run.thinking ?? "default";
  const signIn = credential.auth;
  const publicParts = [model, harness, provider, signIn, reasoningLevel];
  return {
    key: JSON.stringify([...publicParts, endpoint]),
    id: [...publicParts, ...(custom ? [`#${sha256(endpoint).slice(0, 8)}`] : [])].join("|"),
    catalogId,
    modelName: typed ?? run.modelName,
    // The catalog's current name, so old and new runs of one model are labelled alike.
    label: typed ?? findModel(catalogId)?.label ?? run.modelLabel,
    harness,
    reasoningLevel,
    provider,
    signIn,
    custom,
    ...(custom && endpoint ? { endpoint } : {}),
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
