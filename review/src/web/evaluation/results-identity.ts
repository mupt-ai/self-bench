import { findModel, models } from "../../../../src/contracts/models";
import { findListedModel, isGateway } from "../../../../src/gateways";
import type { EvaluationRun, Harness } from "./api";

/**
 * The release's setting for a run's trials on one harness (settingOf in
 * src/public/release-results.ts): model, harness and reasoning, whatever route reached the model.
 * A run from before runs recorded their credentials has none, and is left out, as a release
 * leaves it out.
 */
export function identityOf(run: EvaluationRun, harness: Harness) {
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
  const model = custom ? `custom/${typed}` : (catalog?.id ?? run.model);
  return {
    // A condition is a fourth part, as settingOf adds it, so the baseline keeps its key.
    key: JSON.stringify([
      model,
      harness,
      run.thinking ?? "default",
      ...(run.condition ? [run.condition.id] : []),
    ]),
    label: typed ?? catalog?.label ?? findListedModel(run.model)?.label ?? run.modelLabel,
    modelName: typed ?? (catalog?.vendor ? `${catalog.vendor}/${catalog.id}` : run.modelName),
    provider: custom ? "custom" : (catalog?.vendor ?? run.credentials.provider),
    harness,
    ...(run.thinking ? { thinking: run.thinking } : {}),
    ...(run.condition ? { condition: { id: run.condition.id, name: run.condition.name } } : {}),
  };
}
export type Identity = NonNullable<ReturnType<typeof identityOf>>;
