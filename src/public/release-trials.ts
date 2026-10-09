import type { ReleaseLine } from "../db/releases.js";
import { evaluationTaskKey } from "../evaluation/models.js";
import { transcriptSteps } from "../evaluation/transcript.js";
import type { EvaluationRun, EvaluationTrial, SolverStep } from "../evaluation/types.js";
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

/** Where a release's trials are read from: their runs, and the files each run kept. */
export interface TrialSource {
  run(line: ReleaseLine, evaluationId: string): Promise<EvaluationRun | undefined>;
  /** One of a run's artifacts by its name in `trial.artifacts`, as text. */
  artifact(line: ReleaseLine, evaluationId: string, name: string): Promise<string | undefined>;
}

/**
 * A trial's steps read again from the transcript it kept, when that gives more than its record.
 * Trials recorded before the whole transcript was read kept only its last 100k characters of
 * steps; the kept transcript usually has them all (Pi's last event repeats the conversation).
 */
export async function fullerSteps(
  trial: Pick<EvaluationTrial, "steps" | "artifacts">,
  read: (name: string) => Promise<string | undefined>,
): Promise<SolverStep[]> {
  const names = trial.artifacts.filter((name) => /\/agent\/(pi\.txt|trajectory\.json)$/.test(name));
  const files = new Map<string, string>();
  for (const name of names) {
    const text = await read(name);
    if (text !== undefined) files.set(name, text);
  }
  const steps = transcriptSteps(files);
  return steps && steps.length > trial.steps.length ? steps : trial.steps;
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

/** A section heading of the trial log: Harbor's output, or the path of a file it kept. */
const SECTION = /^--- (Harbor output|\S+) ---$/m;

/**
 * The verifier's test output, from its section of the trial log (output.ts `trialLog`, which
 * already bounds it); undefined when the trial kept none.
 */
function verifierOutput(log: string): string | undefined {
  const parts = log.split(SECTION);
  for (let index = 1; index < parts.length; index += 2) {
    if (!parts[index]?.endsWith("/verifier/test-stdout.txt")) continue;
    const text = parts[index + 1]?.trim();
    return text ? redactSecrets(text) : undefined;
  }
  return undefined;
}

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
  /** The trial's steps, when read again from its transcript (`fullerSteps`). */
  steps?: readonly SolverStep[],
): PublishedTrial | undefined {
  const { result } = chosen;
  const trial = result.trialIndex === undefined ? undefined : run.trials[result.trialIndex];
  if (
    !trial ||
    trial.harness !== partsOf(chosen.settingKey)?.[1] ||
    evaluationTaskKey(trial.runId, trial.taskId) !== chosen.taskKey
  )
    return undefined;
  const output = verifierOutput(trial.log);
  return {
    taskId: chosen.taskId,
    settingId: chosen.settingId,
    // What the release counted, not the trial's reward read again.
    passed: result.pass === true,
    // The verifier's checks (task/verifier.ts): the reward and each condition it requires.
    rewards: trial.rewards,
    ...(trial.startedAt ? { startedAt: trial.startedAt } : {}),
    ...(trial.finishedAt ? { finishedAt: trial.finishedAt } : {}),
    ...(trial.agentTimedOut ? { agentTimedOut: true } : {}),
    ...(run.agentMinutes !== undefined ? { agentMinutes: run.agentMinutes } : {}),
    ...(trial.apiCostUsd !== undefined ? { apiCostUsd: trial.apiCostUsd } : {}),
    ...(trial.costSource ? { costSource: trial.costSource } : {}),
    ...(trial.tokenUsage ? { tokenUsage: trial.tokenUsage } : {}),
    ...(trial.cacheWritesInferred ? { cacheWritesInferred: true } : {}),
    steps: (steps ?? trial.steps).map(redactedStep),
    ...(output ? { verifierOutput: output } : {}),
  };
}
