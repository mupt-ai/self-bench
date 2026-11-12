import { findModel, models, type ThinkingLevel } from "../contracts/models.js";
import { findListedModel, isGateway } from "../gateways/index.js";
import type { Harness } from "./models.js";
import type { EvaluationInput, EvaluationRun, SubagentModel } from "./types.js";

/**
 * A setting is a model, harness, and reasoning level, plus the run condition its trials ran under
 * and the model its subagents ran on, when it has either. The Results page and published releases
 * both group a run's trials by it.
 */
export interface Setting {
  /** Stable identity across provider, sign-in, and endpoint changes: the parts as JSON. */
  key: string;
  /** Public identity of the setting: the parts joined with `|`. */
  id: string;
  catalogId: string;
  modelName: string;
  label: string;
  harness: Harness;
  reasoningLevel: ThinkingLevel;
  provider: NonNullable<EvaluationInput["credentials"]>["provider"];
  custom: boolean;
  /** The run condition its trials ran under (conditions.ts); none for the baseline. */
  condition?: { readonly id: string; readonly name: string };
  /** The model its subagents ran on (subagents.ts), when not its own. */
  subagent?: { readonly catalogId: string; readonly label: string };
}

/**
 * A subagent model's part of a setting's key: its catalog id, so the setting is the same whatever
 * credential served the subagents, marked so it never reads as a condition's id.
 */
export function subagentPart(subagent: Pick<SubagentModel, "catalogId">): string {
  return `subagent:${subagent.catalogId}`;
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
  // Custom models are recorded as `openai/<typed name>`; the typed name is the identity.
  const typed = custom ? run.modelName.replace(/^openai\//, "") : undefined;
  const catalogId = custom ? "custom" : (catalog?.id ?? run.model);
  const model = custom ? `custom/${typed}` : catalogId;
  const reasoningLevel = run.thinking ?? "default";
  const { condition, subagent } = run;
  // A condition and a subagent model are further parts, so every other setting keeps the key it
  // always had.
  const parts = [
    model,
    harness,
    reasoningLevel,
    ...(condition ? [condition.id] : []),
    ...(subagent ? [subagentPart(subagent)] : []),
  ];
  const label = typed ?? catalog?.label ?? findListedModel(run.model)?.label ?? run.modelLabel;
  return {
    key: JSON.stringify(parts),
    id: parts.join("|"),
    catalogId,
    modelName: typed ?? (catalog?.vendor ? `${catalog.vendor}/${catalog.id}` : run.modelName),
    // Every chart, table and page shows a setting by its label, so the label names both models.
    label: subagent ? `${label} + ${subagent.label} Subagents` : label,
    harness,
    reasoningLevel,
    // This describes the model's vendor, not the credential route of a selected trial.
    provider: custom ? "custom" : (catalog?.vendor ?? run.credentials.provider),
    custom,
    ...(condition ? { condition: { id: condition.id, name: condition.name } } : {}),
    ...(subagent ? { subagent: { catalogId: subagent.catalogId, label: subagent.label } } : {}),
  };
}
