import type { CredentialInfo } from "../../../../src/db/credentials";
import { evaluationTaskKey, harnessLabels } from "../../../../src/evaluation/models";
import type { EvaluationRun, Harness } from "./api";
import { thinkingLabel } from "./run-presentation";
import type { RetrySelection } from "./run-retry";

type TaskKey = { runId: string; taskId: string };

/** One setting the scope has already run, and the tasks it has no completed result on. */
interface MissingSetting {
  /** Model, harness and reasoning, as the Results page names them. */
  label: string;
  harness: Harness;
  missing: number;
}

/** What Run Missing would start: the settings with gaps, and the comparisons that fill them. */
export interface MissingWork {
  settings: MissingSetting[];
  /** Trials the comparisons run: each setting's missing tasks. */
  trials: number;
  /** One per set of settings with the same gaps, of at most twelve models each. */
  selections: RetrySelection[];
}

/** The most models one comparison takes (comparisonSchema). */
const MODELS_PER_COMPARISON = 12;

/** A setting among runs: model, its typed name if custom, reasoning and harness, and a credential. */
interface Setting {
  catalogId: string;
  customModel?: string;
  credentialId: string;
  thinking?: EvaluationRun["thinking"];
  harness: Harness;
  label: string;
  done: Set<string>;
}

/**
 * The comparisons that give every setting the scope has run a completed result on every task it
 * can use now, as each setting ran before: its model, reasoning and model credential, on the
 * newest run's sandbox. A setting run with several model credentials uses its newest that still
 * exists, and one with none left is left out, as is a run before runs recorded credentials.
 * Undefined when nothing is missing.
 */
export function missingWork(
  runs: readonly EvaluationRun[],
  tasks: readonly TaskKey[],
  credentials: readonly Pick<CredentialInfo, "id" | "kind">[],
  /** A fresh comparison id, asked for once per comparison. */
  newId: () => string,
  sandboxCredentialId?: string,
): MissingWork | undefined {
  const usable = new Set(credentials.map((credential) => credential.id));
  const settings = new Map<string, Setting>();
  const live = runs
    .filter((run) => !run.deletedAt && run.credentials)
    // Oldest first, so a setting run with several credentials keeps its newest usable one.
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const run of live) {
    const credentialId = run.credentials?.modelCredentialId ?? "";
    const customModel = run.model === "custom" ? run.modelName.replace(/^[^/]+\//, "") : undefined;
    for (const harness of run.harnesses) {
      // A setting is its model, reasoning and harness, whatever credential reached the model, as
      // the server tells configurations apart (completedConfigurationTasks).
      const key = JSON.stringify([run.model, customModel, run.thinking, harness]);
      const setting = settings.get(key) ?? {
        catalogId: run.model,
        ...(customModel ? { customModel } : {}),
        credentialId: "",
        ...(run.thinking ? { thinking: run.thinking } : {}),
        harness,
        label: [
          run.modelLabel,
          harnessLabels[harness] ?? harness,
          ...(run.thinking ? [thinkingLabel(run.thinking)] : []),
        ].join(" · "),
        done: new Set<string>(),
      };
      if (credentialId === "managed-model" || usable.has(credentialId))
        setting.credentialId = credentialId;
      settings.set(key, setting);
      // A trial still going counts as done: running it again would run it twice.
      for (const trial of run.trials)
        if (trial.harness === harness && trial.status !== "failed")
          setting.done.add(evaluationTaskKey(trial.runId, trial.taskId));
    }
  }
  const keys = tasks.map((task) => evaluationTaskKey(task.runId, task.taskId));
  // A setting none of whose credentials remain is left out.
  const gaps = [...settings.values()]
    .filter((setting) => setting.credentialId)
    .map((setting) => ({ setting, missing: keys.filter((key) => !setting.done.has(key)) }))
    .filter((gap) => gap.missing.length > 0);
  if (gaps.length === 0) return undefined;
  const newest = live.at(-1);
  const sandboxId = sandboxCredentialId ?? newest?.credentials?.sandboxCredentialId ?? "";
  const kind = credentials.find((credential) => credential.id === sandboxId)?.kind;
  const judgeCredentialId = newest?.credentials?.judgeCredentialId;
  // A comparison runs each of its models on all its tasks, and skips only completed trials, so
  // settings with the same gaps go together: none runs a task it has, or is still running.
  const byGaps = new Map<string, Map<string, RetrySelection["models"][number]>>();
  for (const { setting, missing } of gaps) {
    const models = byGaps.get(missing.join("\n")) ?? new Map();
    // Harnesses share an entry only on one credential: a sign-in serves its own harness alone.
    const key = JSON.stringify([
      setting.catalogId,
      setting.customModel,
      setting.thinking,
      setting.credentialId,
    ]);
    const entry = models.get(key) ?? {
      catalogId: setting.catalogId,
      ...(setting.customModel ? { customModel: setting.customModel } : {}),
      credentialId: setting.credentialId,
      ...(setting.thinking ? { thinking: setting.thinking } : {}),
      harnesses: [],
    };
    entry.harnesses.push(setting.harness);
    models.set(key, entry);
    byGaps.set(missing.join("\n"), models);
  }
  const selections = [...byGaps].flatMap(([missingKeys, models]) => {
    const missing = new Set(missingKeys.split("\n"));
    const entries = [...models.values()];
    return Array.from(
      { length: Math.ceil(entries.length / MODELS_PER_COMPARISON) },
      (_, index): RetrySelection => ({
        id: newId(),
        models: entries.slice(index * MODELS_PER_COMPARISON, (index + 1) * MODELS_PER_COMPARISON),
        sandbox: sandboxId === "managed-sandbox" ? "managed" : (kind ?? newest?.sandbox ?? ""),
        sandboxCredentialId: sandboxId,
        tasks: tasks.filter((task) => missing.has(evaluationTaskKey(task.runId, task.taskId))),
        ...(judgeCredentialId ? { judgeCredentialId } : {}),
        skipCompleted: true,
      }),
    );
  });
  return {
    settings: gaps.map(({ setting, missing }) => ({
      label: setting.label,
      harness: setting.harness,
      missing: missing.length,
    })),
    trials: gaps.reduce((sum, gap) => sum + gap.missing.length, 0),
    selections,
  };
}
