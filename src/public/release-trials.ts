import type { ReleaseLine } from "../db/releases.js";
import { evaluationTaskKey } from "../evaluation/models.js";
import type { EvaluationRun, SolverStep } from "../evaluation/types.js";
import { redactSecrets } from "../lib/redact.js";
import type { PublishedTrial } from "./release-types.js";

/** One setting's result on one task, as a release's `detail.results` records it (release-build.ts). */
export interface ReleasedResult {
  pass?: boolean;
  evaluationId?: string;
  trialIndex?: number;
}

/** A release's results by setting key, then task key, with the line whose repository holds them. */
export interface ReleasedResults {
  line: ReleaseLine;
  results: Record<string, Record<string, ReleasedResult>>;
}

/** A setting key's parts: model, harness, and reasoning level, as `settingOf` writes them. */
function partsOf(settingKey: string): string[] | undefined {
  try {
    const parts: unknown = JSON.parse(settingKey);
    return Array.isArray(parts) && parts.every((part) => typeof part === "string")
      ? parts
      : undefined;
  } catch {
    return undefined;
  }
}

/** The public id of the setting a key names, joined as `settingOf` (release-results.ts) joins it. */
export const settingIdOf = (settingKey: string): string | undefined =>
  partsOf(settingKey)?.join("|");

/**
 * Redacted again on the way out: the runner already replaced the run's own secrets, and this
 * catches any other credential an agent printed (an `env` dump, a config file it read).
 */
const redactedStep = (step: SolverStep): SolverStep => ({
  ...step,
  text: redactSecrets(step.text),
  tools: step.tools.map((tool) => ({
    ...tool,
    input: redactSecrets(tool.input),
    output: redactSecrets(tool.output),
  })),
});

/**
 * The trial a release chose for one setting on one task, as selfbench.dev shows it: undefined
 * when its run no longer holds that trial at the recorded place.
 */
export function publishedTrial(
  run: EvaluationRun,
  chosen: {
    settingKey: string;
    settingId: string;
    taskKey: string;
    taskId: string;
    result: ReleasedResult;
  },
): PublishedTrial | undefined {
  const { result } = chosen;
  const trial = result.trialIndex === undefined ? undefined : run.trials[result.trialIndex];
  if (
    !trial ||
    trial.harness !== partsOf(chosen.settingKey)?.[1] ||
    evaluationTaskKey(trial.runId, trial.taskId) !== chosen.taskKey
  )
    return undefined;
  return {
    taskId: chosen.taskId,
    settingId: chosen.settingId,
    // What the release counted, not the trial's reward read again.
    passed: result.pass === true,
    ...(trial.startedAt ? { startedAt: trial.startedAt } : {}),
    ...(trial.finishedAt ? { finishedAt: trial.finishedAt } : {}),
    ...(trial.agentTimedOut ? { agentTimedOut: true } : {}),
    ...(run.agentMinutes !== undefined ? { agentMinutes: run.agentMinutes } : {}),
    ...(trial.apiCostUsd !== undefined ? { apiCostUsd: trial.apiCostUsd } : {}),
    ...(trial.costSource ? { costSource: trial.costSource } : {}),
    ...(trial.tokenUsage ? { tokenUsage: trial.tokenUsage } : {}),
    ...(trial.cacheWritesInferred ? { cacheWritesInferred: true } : {}),
    steps: trial.steps.map(redactedStep),
  };
}
