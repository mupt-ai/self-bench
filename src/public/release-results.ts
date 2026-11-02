import { eligibleTrial } from "../evaluation/eligible.js";
import { evaluationTaskKey, type Harness } from "../evaluation/models.js";
import { type Setting, settingOf } from "../evaluation/setting.js";
import type { EvaluationRun, EvaluationTrial } from "../evaluation/types.js";
import type { ReleaseSignIn } from "./release-types.js";

export type { Setting } from "../evaluation/setting.js";

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

/**
 * The setting a run's trials on `harness` belong to, or undefined when it cannot resolve. Without
 * `credentials`, as on the app's Results page, any recorded credential resolves.
 */
function releaseSettingOf(
  run: EvaluationRun,
  harness: Harness,
  credentials?: ReadonlyMap<string, CredentialFacts>,
): Setting | undefined {
  if (!run.credentials) return undefined;
  const credentialId = run.credentials.modelCredentialId;
  if (credentials && credentialId !== MANAGED_MODEL && !credentials.has(credentialId))
    return undefined;
  return settingOf(run, harness);
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
  credentials?: ReadonlyMap<string, CredentialFacts>,
): Map<string, SettingResults> {
  const bySetting = new Map<string, SettingResults>();
  for (const run of runs) {
    for (const [index, trial] of run.trials.entries()) {
      if (!eligibleTrial(trial)) continue;
      const setting = releaseSettingOf(run, trial.harness, credentials);
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
