import type { ArtifactStore } from "../artifacts/index.js";
import { expandBundle } from "../generation/runs/bundle.js";
import type { SettingResults } from "../public/release-results.js";
import { excerpt, timeLimit, VERIFIER_FILE } from "./failure-material.js";
import type { SummaryTask } from "./model-summary.js";
import { evaluationTaskKey, harnessLabels } from "./models.js";
import type { EvaluationScope } from "./scope.js";
import { evaluationPrefix } from "./store.js";
import type { EvaluationTrial } from "./types.js";

/**
 * The most failures read per configuration. Failures the other configurations passed come first,
 * since those say the most about it; the rest are only counted in the outcomes.
 */
const MAX_FAILURES = 12;
/** Task bundles read at once while gathering instructions. */
const READS_AT_ONCE = 8;

/** A configuration's label in the material and the reply: C1, C2, … */
export const labelOf = (index: number) => `C${index + 1}`;

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
 * Every chosen configuration's results in one place, so one reply can judge them all alike: the
 * configurations and their labels, each task with the start of its instruction and every
 * configuration's outcome on it, then each configuration's most telling failures with their
 * evidence, each part capped.
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
  const instruction = await instructions(store, scored);
  const configurations = chosen.map(({ setting, results }, index) => {
    const passed = [...results.values()].filter(({ trial }) => trial.rewards.reward === 1).length;
    const name = [
      setting.label,
      `${setting.reasoningLevel} reasoning`,
      harnessLabels[setting.harness],
    ].join(" · ");
    return `<configuration label="${labelOf(index)}" passed="${passed} of ${results.size}">${name}</configuration>`;
  });
  const outcomes = scored.map((task) => {
    const key = evaluationTaskKey(task.runId, task.taskId);
    const line = chosen
      .flatMap(({ results }, index) => {
        const result = results.get(key);
        return result
          ? [`${labelOf(index)} ${result.trial.rewards.reward === 1 ? "passed" : "failed"}`]
          : [];
      })
      .join(", ");
    return `<task id="${task.taskId}" outcomes="${line}">${opening(instruction.get(key) ?? "", 250)}</task>`;
  });
  const passedBy = (key: string) =>
    chosen.filter(({ results }) => results.get(key)?.trial.rewards.reward === 1).length;
  const failures = await Promise.all(
    chosen.map(async ({ results }, index) => {
      const failed = [...results]
        .filter(([, { trial }]) => trial.rewards.reward !== 1)
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

/** A failure's checks, and its explanation, or the verifier's output where none was written. */
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
  return [
    `<failed_task id="${trial.taskId}">`,
    section("verifier_checks", JSON.stringify(trial.rewards), 300),
    timeLimit(trial) ?? "",
    section("explanation", explained, 700),
    section("verifier_output", output.join("\n\n"), 1_000),
    "</failed_task>",
  ]
    .filter(Boolean)
    .join("\n");
}
