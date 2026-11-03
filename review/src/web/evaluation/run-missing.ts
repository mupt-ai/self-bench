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
  /** One per twelve models, the most a comparison takes. */
  selections: RetrySelection[];
}

/** The most models one comparison takes (comparisonSchema). */
const MODELS_PER_COMPARISON = 12;

/** A setting's identity among runs: model, its typed name if custom, credential, reasoning, harness. */
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
 * newest run's sandbox. A setting whose model credential is gone is left out, as is a run before
 * runs recorded their credentials. Undefined when nothing is missing.
 *
 * The comparison names the tasks any setting misses and skips, per setting, the ones it already
 * completed (`skipCompleted`, as Run Missing Tasks does), so each setting runs only its own gaps.
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
  const live = runs.filter((run) => !run.deletedAt && run.credentials);
  for (const run of live) {
    const credentialId = run.credentials?.modelCredentialId ?? "";
    if (credentialId !== "managed-model" && !usable.has(credentialId)) continue;
    const customModel = run.model === "custom" ? run.modelName.replace(/^[^/]+\//, "") : undefined;
    for (const harness of run.harnesses) {
      const key = JSON.stringify([run.model, customModel, credentialId, run.thinking, harness]);
      const setting = settings.get(key) ?? {
        catalogId: run.model,
        ...(customModel ? { customModel } : {}),
        credentialId,
        ...(run.thinking ? { thinking: run.thinking } : {}),
        harness,
        label: [
          run.modelLabel,
          harnessLabels[harness] ?? harness,
          ...(run.thinking ? [thinkingLabel(run.thinking)] : []),
        ].join(" · "),
        done: new Set<string>(),
      };
      settings.set(key, setting);
      // A trial still going counts as done: running it again would run it twice.
      for (const trial of run.trials)
        if (trial.harness === harness && trial.status !== "failed")
          setting.done.add(evaluationTaskKey(trial.runId, trial.taskId));
    }
  }
  const keys = tasks.map((task) => evaluationTaskKey(task.runId, task.taskId));
  const gaps = [...settings.values()]
    .map((setting) => ({ setting, missing: keys.filter((key) => !setting.done.has(key)) }))
    .filter((gap) => gap.missing.length > 0);
  if (gaps.length === 0) return undefined;
  const newest = [...live].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const sandboxId = sandboxCredentialId ?? newest?.credentials?.sandboxCredentialId ?? "";
  const kind = credentials.find((credential) => credential.id === sandboxId)?.kind;
  // One model entry per model, reasoning and credential, with every harness that has gaps.
  const models = new Map<string, RetrySelection["models"][number]>();
  for (const { setting } of gaps) {
    const key = JSON.stringify([
      setting.catalogId,
      setting.customModel,
      setting.credentialId,
      setting.thinking,
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
  }
  const missing = new Set(gaps.flatMap((gap) => gap.missing));
  const judgeCredentialId = newest?.credentials?.judgeCredentialId;
  const entries = [...models.values()];
  const chunks = Array.from(
    { length: Math.ceil(entries.length / MODELS_PER_COMPARISON) },
    (_, index) => entries.slice(index * MODELS_PER_COMPARISON, (index + 1) * MODELS_PER_COMPARISON),
  );
  return {
    settings: gaps.map(({ setting, missing }) => ({
      label: setting.label,
      harness: setting.harness,
      missing: missing.length,
    })),
    trials: gaps.reduce((sum, gap) => sum + gap.missing.length, 0),
    selections: chunks.map((chunk) => ({
      id: newId(),
      models: chunk,
      sandbox: sandboxId === "managed-sandbox" ? "managed" : (kind ?? newest?.sandbox ?? ""),
      sandboxCredentialId: sandboxId,
      tasks: tasks.filter((task) => missing.has(evaluationTaskKey(task.runId, task.taskId))),
      ...(judgeCredentialId ? { judgeCredentialId } : {}),
      skipCompleted: true,
    })),
  };
}
