import { findModel, models, type ThinkingLevel } from "../contracts/models.js";
import { findListedModel, isGateway } from "../gateways/index.js";
import type { Harness } from "./models.js";
import type { EvaluationInput, EvaluationRun } from "./types.js";

/**
 * A setting is a model, harness, and reasoning level, plus the subagent model when one is set.
 * The Results page and published releases both group a run's trials by it.
 */
export interface Setting {
  /** Stable identity across provider, sign-in, and endpoint changes: the parts as JSON. */
  key: string;
  /** Public identity of this model, harness, and reasoning level: the parts joined with `|`. */
  id: string;
  catalogId: string;
  modelName: string;
  label: string;
  harness: Harness;
  reasoningLevel: ThinkingLevel;
  provider: NonNullable<EvaluationInput["credentials"]>["provider"];
  custom: boolean;
}

/** The setting a run's trials on `harness` belong to, or undefined when the run has no credentials. */
export function settingOf(run: EvaluationRun, harness: Harness): Setting | undefined {
  if (!run.credentials) return undefined;
  const custom = run.credentials.provider === "custom";
  // Curated models use one id on their direct provider and another on the gateways.
  const catalog =
    findModel(run.model) ??
    (isGateway(run.credentials.provider)
      ? models.find((model) => model.openRouter === run.model)
      : undefined);
  const typed = custom ? run.modelName.replace(/^openai\//, "") : undefined;
  const catalogId = custom ? "custom" : (catalog?.id ?? run.model);
  const model = custom ? `custom/${typed}` : catalogId;
  const reasoningLevel = run.thinking ?? "default";
  const parts = [model, harness, reasoningLevel, ...(run.subagent ? [run.subagent.model] : [])];
  const label = typed ?? catalog?.label ?? findListedModel(run.model)?.label ?? run.modelLabel;
  return {
    key: JSON.stringify(parts),
    id: parts.join("|"),
    catalogId,
    modelName: typed ?? (catalog?.vendor ? `${catalog.vendor}/${catalog.id}` : run.modelName),
    label: run.subagent ? `${label} (Subagents: ${run.subagent.model})` : label,
    harness,
    reasoningLevel,
    // This describes the model's vendor, not the credential route of a selected trial.
    provider: custom ? "custom" : (catalog?.vendor ?? run.credentials.provider),
    custom,
  };
}
