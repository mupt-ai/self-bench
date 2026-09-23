import type { EvaluationRun } from "../evaluation/types.js";
import { sha256 } from "../lib/hash.js";
import { type CredentialFacts, resultsBySetting, type Setting } from "./release-results.js";
import {
  approvedKeys,
  type Candidate,
  candidates,
  declinedFor,
  defaultTicks,
  type PreviousRelease,
  type ReleaseTask,
  scores,
  taskSet,
} from "./release-rule.js";
import {
  RELEASE_SCHEMA_VERSION,
  type ReleasePayload,
  type ReleasePublisher,
  type ReleaseRepository,
} from "./release-types.js";

/** JSON with object keys sorted and undefined values dropped, so equal data hashes equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1)))
      : item,
  );
}

/** Everything the rule reads, gathered by the route. */
export interface ReleaseInputs {
  tasks: readonly ReleaseTask[];
  runs: readonly EvaluationRun[];
  credentials: ReadonlyMap<string, CredentialFacts>;
  /** The line's current release, if any. */
  previous?: PreviousRelease;
  /** Task keys released by any earlier row of the line, to label added tasks as returning. */
  everReleased: ReadonlySet<string>;
  /** The line's head; part of the fingerprint, so a teammate's release is noticed. */
  headId?: string;
  /** The line's current release; part of the fingerprint, so a withdrawal is noticed too. */
  currentId?: string;
}

/** A setting as the release dialog lists it. `coverage` indexes into the preview's tasks. */
export interface PreviewSetting extends Omit<Setting, "key"> {
  key: string;
  coverage: number[];
  ticked: boolean;
}

interface PreviewTask {
  key: string;
  runId: string;
  taskId: string;
  difficulty: ReleaseTask["difficulty"];
  sourcePr?: number;
  sourceUrl?: string;
  /** In the current release, new since it, or returning after an earlier release. */
  status: "released" | "new" | "returning";
}

/** What the release dialog shows, and the fingerprint the release must match. */
export interface ReleasePreview {
  fingerprint: string;
  tasks: PreviewTask[];
  /** Tasks of the current release that are no longer approved; they always drop out. */
  removed: Pick<ReleaseTask, "key" | "runId" | "taskId" | "state" | "sourcePr">[];
  /** Approved tasks no listed setting has a result for. */
  unrun: number;
  settings: PreviewSetting[];
}

interface Evaluated {
  approved: string[];
  all: Candidate[];
}

function evaluate(inputs: ReleaseInputs): Evaluated {
  const approved = approvedKeys(inputs.tasks);
  return { approved, all: candidates(resultsBySetting(inputs.runs, inputs.credentials), approved) };
}

/** Changes whenever anything the release would contain, or the line's head, changes. */
function fingerprintOf(inputs: ReleaseInputs, all: readonly Candidate[]): string {
  return sha256(
    canonicalJson({
      head: inputs.headId ?? null,
      current: inputs.currentId ?? null,
      tasks: [...inputs.tasks].sort((left, right) => left.key.localeCompare(right.key)),
      settings: all.map((entry) => [
        entry.setting.key,
        [...entry.results.entries()]
          .filter(([task]) => entry.coverage.has(task))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([task, result]) => [
            task,
            result.run.id,
            result.index,
            result.trial.rewards.reward,
            result.trial.apiCostUsd,
          ]),
      ]),
    }),
  );
}

export function previewRelease(inputs: ReleaseInputs): ReleasePreview {
  const { approved, all } = evaluate(inputs);
  const byKey = new Map(inputs.tasks.map((task) => [task.key, task]));
  const previous = new Set(inputs.previous?.tasks ?? []);
  const ticked = new Set(defaultTicks(all, approved, inputs.previous));
  const index = new Map(approved.map((key, position) => [key, position]));
  const covered = new Set(all.flatMap((entry) => [...entry.coverage]));
  return {
    fingerprint: fingerprintOf(inputs, all),
    tasks: approved.flatMap((key) => {
      const task = byKey.get(key);
      if (!task) return [];
      return [
        {
          key,
          runId: task.runId,
          taskId: task.taskId,
          difficulty: task.difficulty,
          ...(task.sourcePr !== undefined ? { sourcePr: task.sourcePr } : {}),
          ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
          status: previous.has(key)
            ? ("released" as const)
            : inputs.everReleased.has(key)
              ? ("returning" as const)
              : ("new" as const),
        },
      ];
    }),
    removed: [...previous]
      .filter((key) => !index.has(key))
      .sort()
      .map((key) => {
        const task = byKey.get(key);
        const [runId = "", taskId = ""] = task ? [task.runId, task.taskId] : JSON.parse(key);
        return {
          key,
          runId,
          taskId,
          state: task?.state ?? "deleted",
          ...(task?.sourcePr !== undefined ? { sourcePr: task.sourcePr } : {}),
        };
      }),
    unrun: approved.filter((key) => !covered.has(key)).length,
    settings: all.map((entry) => ({
      ...entry.setting,
      coverage: [...entry.coverage].flatMap((key) => {
        const position = index.get(key);
        return position === undefined ? [] : [position];
      }),
      ticked: ticked.has(entry.setting.key),
    })),
  };
}

/** Why a release cannot be written: nothing chosen, no shared task, or an unknown setting. */
export class ReleaseRefused extends Error {}

export interface BuiltRelease {
  /** The public part, before the route adds card metadata and the publisher's avatar. */
  payload: ReleasePayload;
  hash: string;
  /** Private: stored on the row, never served. */
  detail: Record<string, unknown> & PreviousRelease;
}

/** Builds the release for the ticked settings. */
export function buildRelease(
  inputs: ReleaseInputs,
  chosenKeys: readonly string[],
  context: { repository: Pick<ReleaseRepository, "id" | "fullName">; publisher: ReleasePublisher },
): BuiltRelease {
  const { approved, all } = evaluate(inputs);
  const wanted = new Set(chosenKeys);
  const chosen = all.filter((entry) => wanted.has(entry.setting.key));
  if (chosen.length !== wanted.size)
    throw new ReleaseRefused("A selected setting no longer has results; refresh and try again.");
  if (chosen.length === 0) throw new ReleaseRefused("Select at least one setting to release.");
  const tasks = taskSet(chosen, approved);
  if (tasks.length === 0)
    throw new ReleaseRefused("The selected settings have no approved task in common.");
  const settings = scores(chosen, tasks);
  const payload: ReleasePayload = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    repository: { id: context.repository.id, fullName: context.repository.fullName },
    publisher: { login: context.publisher.login, kind: context.publisher.kind },
    tasks: tasks.length,
    settings,
    frontier: settings.filter((setting) => setting.onFrontier).map((setting) => setting.id),
  };
  const results = Object.fromEntries(
    chosen.map((entry) => [
      entry.setting.key,
      Object.fromEntries(
        tasks.map((task) => {
          const result = entry.results.get(task);
          const trial = result?.trial;
          return [
            task,
            {
              pass: trial?.rewards.reward === 1,
              costUsd: trial?.apiCostUsd,
              costSource: trial?.costSource,
              tokens: trial?.tokenUsage,
              startedAt: trial?.startedAt,
              finishedAt: trial?.finishedAt,
              evaluationId: result?.run.id,
              trialIndex: result?.index,
              comparisonId: result?.run.comparisonId,
            },
          ];
        }),
      ),
    ]),
  );
  const released = new Set(tasks);
  const taskList = [...inputs.tasks].sort((left, right) => left.key.localeCompare(right.key));
  const declined = declinedFor(all, wanted, tasks);
  // Covers the published numbers, which trial supplied each result, and the settings left out:
  // declining a setting is a decision the next release's defaults must see, so it is recorded.
  const hash = sha256(canonicalJson({ payload, results, declined }));
  return {
    payload,
    hash,
    detail: {
      tasks,
      settings: chosen.map((entry) => entry.setting.key),
      declined,
      releasedTasks: taskList.filter((task) => released.has(task.key)),
      allTasks: taskList,
      settingsDetail: Object.fromEntries(
        chosen.map((entry) => [entry.setting.key, detailOf(entry, tasks)]),
      ),
      results,
    },
  };
}

/** Private per-setting detail: endpoint, pricing, token sums, and trial dates. */
function detailOf(entry: Candidate, tasks: readonly string[]) {
  const chosen = tasks.flatMap((task) => {
    const result = entry.results.get(task);
    return result ? [result] : [];
  });
  const sum = (field: "input" | "output" | "cacheRead" | "cacheWrite") =>
    chosen.reduce((total, result) => total + (result.trial.tokenUsage?.[field] ?? 0), 0);
  const times = chosen.flatMap((result) =>
    result.trial.finishedAt ? [result.trial.finishedAt] : [],
  );
  times.sort();
  const latestRun = chosen
    .map((result) => result.run)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  return {
    endpoint: entry.setting.endpoint,
    sandbox: latestRun?.sandbox,
    pricing: latestRun?.pricing,
    tokens: {
      input: sum("input"),
      output: sum("output"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
    },
    firstTrialAt: times[0],
    lastTrialAt: times.at(-1),
  };
}
