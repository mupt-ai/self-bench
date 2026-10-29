import type { ArtifactStore } from "../artifacts/index.js";
import { expandBundle } from "../generation/runs/bundle.js";
import type { Setting, SettingResults } from "../public/release-results.js";
import { evaluationCatalog } from "./catalog.js";
import { excerpt, VERIFIER_FILE } from "./failure-material.js";
import type { SummaryTask } from "./model-summary.js";
import { evaluationTaskKey, harnessLabels } from "./models.js";
import type { EvaluationScope } from "./scope.js";
import { evaluationPrefix } from "./store.js";
import type { EvaluationTrial } from "./types.js";

/**
 * The most failures read per configuration. Failures the other configurations passed come first,
 * since those say the most about it; the rest are only counted in the outcomes.
 */
const MAX_FAILURES = 10;
/** Task bundles read at once while gathering instructions and reference changes. */
const READS_AT_ONCE = 8;
/**
 * A task at least this share of its scored configurations failed (with three or more scored) is
 * marked a shared failure: it says more about the task than about any one configuration.
 */
const SHARED_FAILURE = 0.75;

/** A configuration's label in the material and the reply: C1, C2, … */
export const labelOf = (index: number) => `C${index + 1}`;

/**
 * A model's name for people: a label that is really an id ("vercel-ai-gateway/deepseek/…", or a
 * custom endpoint's typed "dari/routing") reads as the catalog's name for it, or else as its model
 * part alone.
 */
function modelName(label: string): string {
  if (!label.includes("/")) return label;
  const known = evaluationCatalog().find((model) => model.id === label);
  return known?.label ?? label.split("/").at(-1) ?? label;
}

/** How the material and the report name a configuration: model, reasoning and harness. */
export const configurationName = (setting: Setting) =>
  [
    modelName(setting.label),
    `${setting.reasoningLevel} reasoning`,
    harnessLabels[setting.harness],
  ].join(" · ");

/** The start of a text, cut at `limit` characters. */
function opening(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/** What the task asks, and how big its reference change is, from its bundle. */
interface TaskShape {
  instruction?: string;
  files?: number;
  lines?: number;
}

/** The files and changed lines of a unified diff. */
function patchSize(patch: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  // Only lines inside a hunk are changes: a file's `---` and `+++` headers come before its first
  // `@@`, while an added line may itself start with `--` or `++`.
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
      inHunk = false;
    } else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && /^[+-]/.test(line)) lines += 1;
  }
  return { files, lines };
}

/** Small, medium or large, by the files and lines the reference change touches. */
function sizeOf({ files, lines }: TaskShape): "small" | "medium" | "large" | undefined {
  if (files === undefined || lines === undefined || files === 0) return undefined;
  if (files <= 2 && lines <= 40) return "small";
  return files >= 6 || lines > 200 ? "large" : "medium";
}

/** Each task's instruction and reference change size, from its bundle, where it can be read. */
async function shapes(
  store: ArtifactStore,
  tasks: readonly SummaryTask[],
): Promise<Map<string, TaskShape>> {
  const found = new Map<string, TaskShape>();
  for (let start = 0; start < tasks.length; start += READS_AT_ONCE) {
    await Promise.all(
      tasks.slice(start, start + READS_AT_ONCE).map(async (task) => {
        const files = (await expandBundle(store, task.bundleKey).catch(() => undefined))?.files;
        const text = (path: string) => files?.find((file) => file.path === path)?.text;
        const [instruction, patch] = [text("instruction.md"), text("solution/gold.patch")];
        found.set(evaluationTaskKey(task.runId, task.taskId), {
          ...(instruction ? { instruction } : {}),
          ...(patch ? patchSize(patch) : {}),
        });
      }),
    );
  }
  return found;
}

/** How a scored attempt failed, as far as its checks say. */
function failureKind({ rewards, agentTimedOut, verifierTimedOut }: EvaluationTrial) {
  if (agentTimedOut) return "ran out of time";
  if (verifierTimedOut) return "its change made the tests hang";
  if (rewards.patch_applied === 0) return "its change did not apply";
  if (rewards.setup_completed === 0) return "the tests could not be set up";
  if (rewards.pass_to_pass === 0 && rewards.fail_to_pass === 0)
    return "broke existing behavior and missed the requested behavior";
  if (rewards.pass_to_pass === 0) return "broke existing behavior";
  if (rewards.fail_to_pass === 0) return "the requested behavior is missing or wrong";
  return undefined;
}

const share = (passed: number, of: number) => `${passed}/${of}`;

/**
 * Every chosen configuration's results in one place, so one reply can judge them all alike: each
 * configuration with its pass rates by difficulty and change size and its time-outs; each task with
 * its difficulty, change size, the start of its instruction and every configuration's outcome;
 * then each configuration's most telling failures, apart from those most configurations shared,
 * with how each failed and its evidence, each part capped.
 */
export async function summaryMaterial(
  store: ArtifactStore,
  scope: EvaluationScope,
  tasks: readonly SummaryTask[],
  chosen: readonly SettingResults[],
): Promise<string> {
  const scored = tasks.filter((task) =>
    chosen.some(({ results }) => results.has(evaluationTaskKey(task.runId, task.taskId))),
  );
  const shape = await shapes(store, scored);
  const keyOf = (task: SummaryTask) => evaluationTaskKey(task.runId, task.taskId);
  const passed = (trial: EvaluationTrial) => trial.rewards.reward === 1;
  const trialsOn = (key: string) => chosen.flatMap(({ results }) => results.get(key)?.trial ?? []);
  const shared = new Set(
    scored.map(keyOf).filter((key) => {
      const tried = trialsOn(key);
      const failed = tried.filter((trial) => !passed(trial)).length;
      return tried.length >= 3 && failed / tried.length >= SHARED_FAILURE;
    }),
  );
  const difficultyOf = new Map(scored.map((task) => [keyOf(task), task.difficulty]));

  const configurations = chosen.map(({ setting, results }, index) => {
    const entries = [...results];
    const trials = entries.map(([, { trial }]) => trial);
    const by = (group: (key: string) => string | undefined, order: readonly string[]) =>
      order
        .flatMap((name) => {
          const inGroup = entries.filter(([key]) => group(key) === name);
          return inGroup.length
            ? [
                `${name} ${share(inGroup.filter(([, { trial }]) => passed(trial)).length, inGroup.length)}`,
              ]
            : [];
        })
        .join(", ");
    const attributes = {
      label: labelOf(index),
      passed: share(trials.filter(passed).length, trials.length),
      by_difficulty: by((key) => difficultyOf.get(key), ["easy", "medium", "hard"]),
      by_change_size: by((key) => sizeOf(shape.get(key) ?? {}), ["small", "medium", "large"]),
      ran_out_of_time: `${trials.filter((trial) => trial.agentTimedOut).length}`,
    };
    const rendered = Object.entries(attributes)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}="${value}"`)
      .join(" ");
    return `<configuration ${rendered}>${configurationName(setting)}</configuration>`;
  });

  const outcomes = scored.map((task) => {
    const key = keyOf(task);
    const { files, lines, instruction } = shape.get(key) ?? {};
    const line = chosen
      .flatMap(({ results }, index) => {
        const result = results.get(key);
        return result ? [`${labelOf(index)} ${passed(result.trial) ? "passed" : "failed"}`] : [];
      })
      .join(", ");
    const attributes = [
      `id="${task.taskId}"`,
      task.difficulty ? `difficulty="${task.difficulty}"` : "",
      files ? `reference_change="${files} files, ${lines} lines"` : "",
      shared.has(key) ? `shared_failure="true"` : "",
      `outcomes="${line}"`,
    ].filter(Boolean);
    return `<task ${attributes.join(" ")}>${opening(instruction ?? "", 250)}</task>`;
  });

  const passedBy = (key: string) => trialsOn(key).filter(passed).length;
  const failures = await Promise.all(
    chosen.map(async ({ results }, index) => {
      const failed = [...results]
        .filter(([key, { trial }]) => !passed(trial) && !shared.has(key))
        .sort(([a], [b]) => passedBy(b) - passedBy(a))
        .slice(0, MAX_FAILURES);
      const evidence = await Promise.all(
        failed.map(([, { run, trial }]) => failedTask(store, scope, run.id, trial)),
      );
      return [`<failures configuration="${labelOf(index)}">`, ...evidence, "</failures>"].join(
        "\n\n",
      );
    }),
  );
  return [configurations.join("\n"), `<tasks>\n${outcomes.join("\n")}\n</tasks>`, ...failures].join(
    "\n\n",
  );
}

/**
 * A failure: how it failed, its checks, and its explanation, or the verifier's output where none
 * was written.
 */
async function failedTask(
  store: ArtifactStore,
  scope: EvaluationScope,
  runId: string,
  trial: EvaluationTrial,
): Promise<string> {
  const section = (tag: string, text: string | undefined, limit: number) =>
    text?.trim() ? `<${tag}>\n${excerpt(text.trim(), limit)}\n</${tag}>` : "";
  const explained = trial.failureSummary?.text;
  const prefix = `${evaluationPrefix(scope, runId)}artifacts/`;
  const output = explained
    ? []
    : await Promise.all(
        trial.artifacts
          .filter((artifact) => VERIFIER_FILE.test(artifact))
          .sort()
          .map(async (artifact) => {
            const bytes = await store.getByKey(`${prefix}${artifact}`);
            return `${artifact.split("/").at(-1)}:\n${Buffer.from(bytes ?? []).toString("utf8")}`;
          }),
      );
  const kind = failureKind(trial);
  return [
    `<failed_task id="${trial.taskId}"${kind ? ` how="${kind}"` : ""}>`,
    section("verifier_checks", JSON.stringify(trial.rewards), 300),
    section("explanation", explained, 700),
    section("verifier_output", output.join("\n\n"), 1_000),
    "</failed_task>",
  ]
    .filter(Boolean)
    .join("\n");
}
