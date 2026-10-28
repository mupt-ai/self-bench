import type { ArtifactStore } from "../artifacts/index.js";
import { expandBundle } from "../generation/runs/bundle.js";
import type { Setting } from "../public/release-results.js";
import { excerpt, timeLimit, VERIFIER_FILE } from "./failure-material.js";
import type { SummaryTask } from "./model-summary.js";
import { evaluationTaskKey, harnessLabels } from "./models.js";
import type { EvaluationScope } from "./scope.js";
import { evaluationPrefix } from "./store.js";
import type { EvaluationRun, EvaluationTrial } from "./types.js";

/**
 * The most failed and passed tasks read. Failures other configurations passed come first, and
 * passes others failed, since those say the most about this one; the rest are counted.
 */
const MAX_FAILURES = 30;
const MAX_PASSES = 60;
/** Task bundles read at once while gathering instructions. */
const READS_AT_ONCE = 8;

/** A configuration's scored result on one task, and how the other configurations did on it. */
export interface ScoredResult {
  run: EvaluationRun;
  trial: EvaluationTrial;
  passed: boolean;
  othersPassed: number;
  othersTried: number;
}

/** The start of a text, cut at `limit` characters. */
function opening(text: string, limit: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/** Each task's instruction, from its bundle; a task whose bundle can't be read has none. */
async function instructions(
  store: ArtifactStore,
  tasks: readonly SummaryTask[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let start = 0; start < tasks.length; start += READS_AT_ONCE) {
    await Promise.all(
      tasks.slice(start, start + READS_AT_ONCE).map(async (task) => {
        const files = await expandBundle(store, task.bundleKey).catch(() => undefined);
        const text = files?.files.find((file) => file.path === "instruction.md")?.text;
        if (text) found.set(evaluationTaskKey(task.runId, task.taskId), text);
      }),
    );
  }
  return found;
}

/**
 * The configuration's results: a line of totals, then its most telling passes, each with the start
 * of its instruction, then its most telling failures with their evidence, each part capped.
 */
export async function summaryMaterial(
  store: ArtifactStore,
  scope: EvaluationScope,
  tasks: readonly SummaryTask[],
  setting: Setting,
  results: readonly ScoredResult[],
): Promise<string> {
  const name = [
    setting.label,
    `${setting.reasoningLevel} reasoning`,
    harnessLabels[setting.harness],
  ].join(" · ");
  const othersShare = ({ othersPassed, othersTried }: ScoredResult) =>
    othersTried ? othersPassed / othersTried : 0.5;
  const passes = results
    .filter((result) => result.passed)
    .sort((a, b) => othersShare(a) - othersShare(b))
    .slice(0, MAX_PASSES);
  const failures = results
    .filter((result) => !result.passed)
    .sort((a, b) => othersShare(b) - othersShare(a))
    .slice(0, MAX_FAILURES);
  const read = new Set(
    [...passes, ...failures].map(({ trial }) => evaluationTaskKey(trial.runId, trial.taskId)),
  );
  const instruction = await instructions(
    store,
    tasks.filter((task) => read.has(evaluationTaskKey(task.runId, task.taskId))),
  );
  const instructionOf = ({ trial }: ScoredResult) =>
    instruction.get(evaluationTaskKey(trial.runId, trial.taskId));
  const others = ({ othersPassed, othersTried }: ScoredResult) =>
    othersTried ? ` others_passed="${othersPassed} of ${othersTried}"` : "";
  const section = (tag: string, text: string | undefined, limit: number) =>
    text?.trim() ? `<${tag}>\n${excerpt(text.trim(), limit)}\n</${tag}>` : "";

  const passed = results.filter((result) => result.passed).length;
  const lines = [
    `<configuration>${name}</configuration>`,
    `<totals>Passed ${passed} of ${results.length} scored tasks.${
      passes.length < passed || failures.length < results.length - passed
        ? ` Shown: ${passes.length} passes and ${failures.length} failures, those that differ most from other configurations first.`
        : ""
    }</totals>`,
    ...passes.map(
      (result) =>
        `<passed_task id="${result.trial.taskId}"${others(result)}>${opening(instructionOf(result) ?? "", 300)}</passed_task>`,
    ),
  ];
  const evidence = await Promise.all(
    failures.map(async (result) => {
      const { run, trial } = result;
      const explained = trial.failureSummary?.text;
      const prefix = `${evaluationPrefix(scope, run.id)}artifacts/`;
      // The verifier's own output only where no explanation says what it meant.
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
      return [
        `<failed_task id="${trial.taskId}"${others(result)}>`,
        section("instruction", instructionOf(result), 1_200),
        section("verifier_checks", JSON.stringify(trial.rewards), 500),
        timeLimit(trial) ?? "",
        section("explanation", explained, 1_500),
        section("verifier_output", output.join("\n\n"), 2_500),
        "</failed_task>",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  );
  return [...lines, ...evidence].join("\n\n");
}
