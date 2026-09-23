import type { TaskState } from "../db/task-record.js";
import type { TaskRecord } from "../db/tasks.js";
import type { Setting, SettingResults } from "./release-results.js";
import type { ReleaseSetting } from "./release-types.js";

/**
 * The release rule as pure functions. The releaser ticks settings; the task set is every
 * approved task all of them have a result for; scores are over exactly that set.
 */

/** A task of the repository in any state, deleted ones included. */
export interface ReleaseTask
  extends Pick<
    TaskRecord,
    "runId" | "taskId" | "difficulty" | "sourcePr" | "sourceUrl" | "reason" | "review"
  > {
  /** `evaluationTaskKey(runId, taskId)`. */
  key: string;
  /** The app's task state, or "deleted" for a deleted task. */
  state: TaskState | "deleted";
  /** Whether a release may use it: see `runnable()`. */
  runnable: boolean;
}

/** What the line's current release recorded, for the default ticks. */
export interface PreviousRelease {
  tasks: readonly string[];
  settings: readonly string[];
  declined: readonly string[];
}

/** A setting the dialog can offer, with the approved tasks it has a result for; never empty. */
export interface Candidate extends SettingResults {
  coverage: Set<string>;
}

/** Runnable task keys in a stable order: the only tasks a release can include. */
export function approvedKeys(tasks: readonly ReleaseTask[]): string[] {
  return tasks
    .filter((task) => task.runnable)
    .map((task) => task.key)
    .sort();
}

/** Settings with at least one result on an approved task, in id order. */
export function candidates(
  bySetting: ReadonlyMap<string, SettingResults>,
  approved: readonly string[],
): Candidate[] {
  const allowed = new Set(approved);
  return [...bySetting.values()]
    .map((entry) => ({
      ...entry,
      coverage: new Set([...entry.results.keys()].filter((key) => allowed.has(key))),
    }))
    .filter((entry) => entry.coverage.size > 0)
    .sort((left, right) => left.setting.id.localeCompare(right.setting.id));
}

const covers = (candidate: Candidate, tasks: Iterable<string>) => {
  for (const task of tasks) if (!candidate.coverage.has(task)) return false;
  return true;
};

/** The settings pre-ticked when the dialog opens: those covering what remains of the current
 * release's task set, minus the ones declined last time. */
export function defaultTicks(
  all: readonly Candidate[],
  approved: readonly string[],
  previous: PreviousRelease | undefined,
): string[] {
  const allowed = new Set(approved);
  const base = (previous?.tasks ?? []).filter((task) => allowed.has(task));
  // Every setting covers the empty set, so an empty base must not pre-tick anything.
  if (base.length === 0) return [];
  const declined = new Set(previous?.declined ?? []);
  return all
    .filter((entry) => covers(entry, base) && !declined.has(entry.setting.key))
    .map((entry) => entry.setting.key);
}

/** Every approved task that all of `chosen` cover. Empty when nothing is chosen. */
export function taskSet(chosen: readonly Candidate[], approved: readonly string[]): string[] {
  if (chosen.length === 0) return [];
  return approved.filter((task) => chosen.every((entry) => entry.coverage.has(task)));
}

/** Settings that cover the task set but were not chosen. */
export function declinedFor(
  all: readonly Candidate[],
  chosen: ReadonlySet<string>,
  tasks: readonly string[],
): string[] {
  return all
    .filter((entry) => !chosen.has(entry.setting.key) && covers(entry, tasks))
    .map((entry) => entry.setting.key);
}

/** Settings no other setting beats on both cost (lower) and accuracy (higher). */
export function frontierOf<T extends { id: string; accuracy: number; costPerTaskUsd: number }>(
  settings: readonly T[],
): Set<string> {
  return new Set(
    settings
      .filter(
        (setting) =>
          !settings.some(
            (other) =>
              other.costPerTaskUsd <= setting.costPerTaskUsd &&
              other.accuracy >= setting.accuracy &&
              (other.costPerTaskUsd < setting.costPerTaskUsd || other.accuracy > setting.accuracy),
          ),
      )
      .map((setting) => setting.id),
  );
}

function publicSetting(
  setting: Setting,
): Omit<
  ReleaseSetting,
  "tasks" | "passed" | "accuracy" | "costPerTaskUsd" | "totalCostUsd" | "onFrontier"
> {
  return {
    id: setting.id,
    model: { catalogId: setting.catalogId, name: setting.modelName, label: setting.label },
    harness: setting.harness,
    reasoningLevel: setting.reasoningLevel,
    provider: setting.provider,
    signIn: setting.signIn,
    custom: setting.custom,
  };
}

/** Each chosen setting's aggregates over exactly `tasks`, with the frontier marked. */
export function scores(chosen: readonly Candidate[], tasks: readonly string[]): ReleaseSetting[] {
  const scored = chosen.map((entry) => {
    const trials = tasks.map((task) => {
      const result = entry.results.get(task);
      if (!result) throw new Error(`setting ${entry.setting.id} lacks task ${task}`);
      return result.trial;
    });
    const passed = trials.filter((trial) => trial.rewards.reward === 1).length;
    const totalCostUsd = trials.reduce((sum, trial) => sum + (trial.apiCostUsd ?? 0), 0);
    return {
      ...publicSetting(entry.setting),
      tasks: tasks.length,
      passed,
      accuracy: (passed / tasks.length) * 100,
      costPerTaskUsd: totalCostUsd / tasks.length,
      totalCostUsd,
      onFrontier: false,
    };
  });
  const frontier = frontierOf(scored);
  return scored.map((setting) => ({ ...setting, onFrontier: frontier.has(setting.id) }));
}
