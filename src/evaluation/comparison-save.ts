import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/index.js";
import type { ComparisonRecord } from "../db/comparisons.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { Vault } from "../db/vault.js";
import { type ManagedOffer, managedHarborEnvironment } from "../generation/billing/managed.js";
import { type CatalogModel, evaluationCatalog } from "./catalog.js";
import type { ComparisonSelection } from "./comparisons.js";
import { defaultThinking, routeFor, signInRefusal, thinkingOptions } from "./models.js";
import { type EvaluationScope, sameScope } from "./scope.js";
import { listEvaluations } from "./store.js";
import { splitCredentialLimits } from "./trial-input.js";
import type { EvaluationInput } from "./types.js";

/** Who a comparison is for: its repository's or org's evaluations, and who asked. */
export interface ComparisonOwner {
  scope: EvaluationScope;
  /** A repository's agent time; a benchmark's tasks run with their own limits instead. */
  agentMinutes?: number;
  orgId: number;
  tenant: string;
  login: string;
  /**
   * Whether the repository is private on GitHub. A public repository's failed trials are
   * explained; unset for a benchmark and anything not confirmed public.
   */
  privateRepo?: boolean;
}

/**
 * Saves a comparison of `selection`'s models over the tasks `freeze` returns, which it calls only
 * once the selection's sandbox checks out. `judge` picks the credential an LLM judge in those
 * tasks calls with, from the org's. A retried request (the same ID and selection) returns the saved
 * comparison; the same ID for anything else is refused.
 */
export async function saveComparison(
  { credentials, comparisons }: Pick<Vault, "credentials" | "comparisons">,
  store: ArtifactStore,
  managed: ManagedOffer,
  owner: ComparisonOwner,
  selection: ComparisonSelection,
  signature: string,
  freeze: () => Promise<EvaluationInput["tasks"]>,
  environment: NodeJS.ProcessEnv,
  judge?: (
    tasks: EvaluationInput["tasks"],
    saved: ReadonlyMap<string, CredentialInfo>,
  ) => string | undefined,
): Promise<ComparisonRecord> {
  const owned = (record: ComparisonRecord) => {
    if (
      record.orgId !== owner.orgId ||
      !sameScope(record.scope, owner.scope) ||
      record.signature !== signature
    )
      throw new Error("Comparison ID belongs to a different selection");
    return record;
  };
  const previous = await comparisons.find(selection.id);
  if (previous) return owned(previous);
  const completed = selection.skipCompleted
    ? completedConfigurationTasks(await listEvaluations(store, owner.scope))
    : new Set<string>();
  if ((await comparisons.countForOrg(owner.orgId)) >= 500)
    throw new Error("Comparison retention limit reached; contact an operator");
  const saved = new Map(
    (await credentials.list(owner.orgId)).map((credential) => [credential.id, credential]),
  );
  const managedSandbox = selection.sandbox === "managed";
  if (managedSandbox && managedHarborEnvironment(environment) !== "modal")
    throw new Error("Managed evaluation requires platform Modal credentials.");
  const sandbox = managedSandbox
    ? { id: "managed-sandbox", kind: "modal" }
    : saved.get(selection.sandboxCredentialId);
  if (
    !sandbox ||
    (managedSandbox
      ? selection.sandboxCredentialId !== "managed-sandbox"
      : sandbox.kind !== selection.sandbox)
  )
    throw new Error("Select your matching sandbox credential");
  const frozen = await freeze();
  const judgeCredentialId = judge?.(frozen, saved);
  const seen = new Set<string>();
  const createdAt = new Date().toISOString();
  const catalogModels = evaluationCatalog();
  const selections = selection.models.map(async (selected): Promise<EvaluationInput[]> => {
    const model: CatalogModel | undefined =
      selected.catalogId === "custom" && selected.customModel
        ? {
            id: "custom",
            label: "Custom model",
            source: "",
            provider: "custom",
            model: selected.customModel,
            harnesses: ["pi"],
          }
        : catalogModels.find((entry) => entry.id === selected.catalogId);
    if (!model || (selected.catalogId !== "custom" && selected.customModel))
      throw new Error("Unknown model");
    const managedModel = selected.credentialId === "managed-model";
    const credential = managedModel
      ? { id: "managed-model", kind: "openrouter" as const, auth: "api-key" as const }
      : saved.get(selected.credentialId);
    const route = credential ? routeFor(model, credential.kind) : undefined;
    if (managedModel && !managed.models)
      throw new Error("Managed models are not available on this deployment.");
    if (!credential || !route) throw new Error("Select your matching provider credential");
    const refusal = signInRefusal(credential.auth, selected.harnesses);
    if (refusal) throw new Error(refusal);
    if (
      selected.harnesses.some((harness) => !route.harnesses.includes(harness)) ||
      new Set(selected.harnesses).size !== selected.harnesses.length
    )
      throw new Error("Unsupported or repeated harness");
    const levels = thinkingOptions(route, selected.harnesses);
    const thinking = selected.thinking ?? defaultThinking(levels);
    if (!levels.includes(thinking))
      throw new Error("Unsupported thinking level for this model and harness");
    const modelIdentity = selected.catalogId === "custom" ? route.model : model.id;
    for (const harness of selected.harnesses) {
      const pair = configurationIdentity(modelIdentity, thinking, harness);
      if (seen.has(pair))
        throw new Error("Select each model, harness, and thinking configuration once");
      seen.add(pair);
    }
    const modelName = `${route.provider === "custom" ? "openai" : route.provider}/${route.model}`;
    const groups = selection.skipCompleted
      ? selected.harnesses.map((harness) => ({
          harnesses: [harness],
          tasks: frozen.filter(
            (task) =>
              !completed.has(
                configurationTaskKey(modelIdentity, thinking, harness, task.runId, task.taskId),
              ),
          ),
        }))
      : [{ harnesses: selected.harnesses, tasks: frozen }];
    const { pricing } = route;
    return groups
      .filter((group) => group.tasks.length > 0)
      .map(
        (group): EvaluationInput => ({
          id: randomUUID(),
          ...owner.scope,
          model: model.id,
          modelName,
          thinking,
          harnesses: group.harnesses,
          sandbox: selection.sandbox === "managed" ? "modal" : selection.sandbox,
          tasks: group.tasks,
          ...(owner.agentMinutes !== undefined ? { agentMinutes: owner.agentMinutes } : {}),
          ...taskMinutes(group.tasks),
          tenant: owner.tenant,
          startedBy: owner.login,
          createdAt,
          ...(pricing ? { pricing } : {}),
          // A benchmark is a public Harbor registry dataset, so its failures may be explained.
          ...(owner.scope.benchmarkId !== undefined || owner.privateRepo === false || managedModel
            ? { explainFailures: true }
            : {}),
          credentialOrgId: owner.orgId,
          comparisonId: selection.id,
          credentials: {
            modelCredentialId: credential.id,
            sandboxCredentialId: sandbox.id,
            provider: route.provider,
            auth: credential.auth,
            ...(judgeCredentialId ? { judgeCredentialId } : {}),
          },
        }),
      );
  });
  const inputs = (await Promise.all(selections)).flat();
  if (inputs.length === 0)
    throw new Error("Every selected configuration and task already has a completed result.");
  splitCredentialLimits(inputs, (id) => saved.get(id)?.maxSandboxes);
  return owned(
    await comparisons.insert({
      id: selection.id,
      orgId: owner.orgId,
      scope: owner.scope,
      createdAt,
      signature,
      inputs,
    }),
  );
}

/** The longest of the tasks' own limits, for registry tasks, which run with them. */
function taskMinutes(tasks: EvaluationInput["tasks"]): { taskMinutes?: number } {
  const minutes = tasks.flatMap((task) => (task.minutes ? [task.minutes] : []));
  return minutes.length ? { taskMinutes: Math.max(...minutes) } : {};
}

function configurationIdentity(model: string, thinking: string | undefined, harness: string) {
  return JSON.stringify([model, thinking ?? "default", harness]);
}

function configurationTaskKey(
  model: string,
  thinking: string | undefined,
  harness: string,
  runId: string,
  taskId: string,
) {
  return JSON.stringify([configurationIdentity(model, thinking, harness), runId, taskId]);
}

function completedConfigurationTasks(runs: Awaited<ReturnType<typeof listEvaluations>>) {
  const completed = new Set<string>();
  for (const run of runs) {
    for (const trial of run.trials) {
      if (trial.status === "completed")
        completed.add(
          configurationTaskKey(
            run.model === "custom" ? run.modelName.replace(/^[^/]+\//, "") : run.model,
            run.thinking,
            trial.harness,
            trial.runId,
            trial.taskId,
          ),
        );
    }
  }
  return completed;
}
