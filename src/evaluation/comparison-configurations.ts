import type { CredentialInfo } from "../db/credentials.js";
import type { CatalogModel } from "./catalog.js";
import type { ComparisonSelection } from "./comparisons.js";
import { defaultThinking, type Harness, routeFor, signInRefusal } from "./models.js";
import { subagentPart } from "./setting.js";
import { subagentRefusal } from "./subagents.js";
import type { EvaluationRun, SubagentModel } from "./types.js";

/**
 * A configuration: model, thinking, harness, the run condition it ran under, if any, and the
 * subagent model, if it set one, by its catalog id, as a setting names it (setting.ts).
 */
export function configurationIdentity(
  model: string,
  thinking: string | undefined,
  harness: string,
  under: {
    condition?: string | undefined;
    subagent?: Pick<SubagentModel, "catalogId"> | undefined;
  },
) {
  return JSON.stringify([
    model,
    thinking ?? "default",
    harness,
    ...(under.condition ? [under.condition] : []),
    ...(under.subagent ? [subagentPart(under.subagent)] : []),
  ]);
}

export function configurationTaskKey(configuration: string, runId: string, taskId: string) {
  return JSON.stringify([configuration, runId, taskId]);
}

export function completedConfigurationTasks(runs: EvaluationRun[]) {
  const completed = new Set<string>();
  for (const run of runs) {
    for (const trial of run.trials) {
      if (trial.status === "completed")
        completed.add(
          configurationTaskKey(
            configurationIdentity(
              run.model === "custom" ? run.modelName.replace(/^[^/]+\//, "") : run.model,
              run.thinking,
              trial.harness,
              { condition: run.condition?.id, subagent: run.subagent },
            ),
            trial.runId,
            trial.taskId,
          ),
        );
    }
  }
  return completed;
}

/**
 * The subagent model a selection names, frozen for its runs: a catalog model other than the
 * run's own, on a saved credential (or the managed one) that serves it by name on every selected
 * harness. Throws why it cannot be one (subagentRefusal).
 */
export function selectedSubagent(
  selected: NonNullable<ComparisonSelection["models"][number]["subagent"]>,
  harnesses: readonly Harness[],
  model: Pick<CatalogModel, "id">,
  /** The kind of the credential serving the run's own model. */
  provider: string,
  known: {
    catalogModels: readonly CatalogModel[];
    saved: ReadonlyMap<string, CredentialInfo>;
    /** Whether this deployment offers managed models. */
    managed: boolean;
  },
): SubagentModel {
  const subagent = known.catalogModels.find((entry) => entry.id === selected.catalogId);
  const managed = selected.credentialId === "managed-model";
  if (managed && !known.managed)
    throw new Error("Managed models are not available on this deployment.");
  const credential = managed
    ? { id: "managed-model", kind: "openrouter" as const, auth: "api-key" as const }
    : known.saved.get(selected.credentialId);
  const route = subagent && credential && routeFor(subagent, credential.kind);
  if (!subagent || !credential || !route)
    throw new Error("Select a subagent model and its matching provider credential");
  const refusal =
    subagentRefusal(harnesses, provider, route.provider) ??
    signInRefusal(credential.auth, harnesses);
  if (refusal) throw new Error(refusal);
  if (harnesses.some((harness) => !route.harnesses.includes(harness)))
    throw new Error("The subagent model's credential does not run every selected harness");
  if (subagent.id === model.id)
    throw new Error("The subagent model is the run's own model; leave it out to use that");
  // The harness asks its subagents' model for the level it runs its own model at, which the
  // subagent model may lack, so the gateway serves it at the level a row of it runs at by default.
  const thinking = defaultThinking(route.thinking?.length ? route.thinking : ["default"]);
  return {
    catalogId: subagent.id,
    model: `${route.provider}/${route.model}`,
    label: subagent.label,
    credentialId: credential.id,
    ...(thinking === "default" ? {} : { thinking }),
  };
}
