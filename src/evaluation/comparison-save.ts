import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/index.js";
import { conditionRunsOn } from "../contracts/conditions.js";
import type { ComparisonRecord } from "../db/comparisons.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { Vault } from "../db/vault.js";
import { type ManagedOffer, managedHarborEnvironment } from "../generation/billing/managed.js";
import { type CatalogModel, evaluationCatalog } from "./catalog.js";
import {
  type comparisonConditions,
  NOTHING_TO_RUN,
  rowConditions,
} from "./comparison-conditions.js";
import {
  completedConfigurationTasks,
  conditionSubagent,
  configurationIdentity,
  configurationTaskKey,
  selectedSubagent,
} from "./comparison-configurations.js";
import type { ComparisonSelection } from "./comparisons.js";
import { conditionRefusal } from "./conditions.js";
import { trialRoute } from "./gateway-trial.js";
import { defaultThinking, routeFor, signInRefusal, thinkingOptions } from "./models.js";
import { assertTasksFitSandbox } from "./resource-check.js";
import { listRuns } from "./run-list.js";
import { type EvaluationScope, sameScope } from "./scope.js";
import { live } from "./store.js";
import { SUBAGENT_NEEDS_GATEWAY } from "./subagents.js";
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
  /** Other scopes whose finished results a "missing only" comparison skips too: a group's members. */
  sources?: readonly EvaluationScope[];
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
  /** The workspace's saved harnesses and the scope's environments, for the pairs that name one. */
  known: Parameters<typeof comparisonConditions>[2] = {},
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
    ? completedConfigurationTasks(
        (
          await Promise.all(
            [owner.scope, ...(owner.sources ?? [])].map(async (scope) =>
              ((await listRuns(store, scope)).runs ?? []).filter(live),
            ),
          )
        ).flat(),
      )
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
  if (
    selection.baseline === false &&
    !selection.conditions?.length &&
    !selection.harnesses?.length &&
    !selection.environments?.length &&
    selection.models.every((model) => model.harness === undefined)
  )
    throw new Error(NOTHING_TO_RUN);
  const frozen = await freeze();
  const byRow = await rowConditions(selection, frozen, known);
  const resourceWarnings = assertTasksFitSandbox(frozen, sandbox);
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
    const serving = { catalogModels, saved, managed: managed.models };
    const subagent = selected.subagent
      ? selectedSubagent(selected.subagent, selected.harnesses, model, route.provider, serving)
      : undefined;
    const levels = thinkingOptions(route, selected.harnesses);
    const thinking = selected.thinking ?? defaultThinking(levels);
    if (!levels.includes(thinking))
      throw new Error("Unsupported thinking level for this model and harness");
    const modelIdentity = selected.catalogId === "custom" ? route.model : model.id;
    const conditions = byRow.get(selected.harness) ?? [];
    for (const harness of selected.harnesses) {
      // The same model on a harness as it is and on a saved harness are two rows, not one twice.
      const pair = configurationIdentity(modelIdentity, thinking, harness, {
        subagent,
        ...(selected.harness !== undefined ? { condition: `saved:${selected.harness}` } : {}),
      });
      if (seen.has(pair))
        throw new Error("Select each model, harness, and thinking configuration once");
      seen.add(pair);
      for (const { condition } of conditions) {
        if (!conditionRunsOn(condition, harness)) continue;
        const refusal = condition && conditionRefusal(condition, harness);
        if (refusal) throw new Error(refusal);
      }
    }
    const modelName = `${route.provider === "custom" ? "openai" : route.provider}/${route.model}`;
    const runCredentials = {
      modelCredentialId: credential.id,
      sandboxCredentialId: sandbox.id,
      provider: route.provider,
      auth: credential.auth,
      ...(judgeCredentialId ? { judgeCredentialId } : {}),
    };
    const groups = conditions.flatMap(({ condition, tasks, subagentCredentialId }) => {
      const harnesses = selected.harnesses.filter((harness) => conditionRunsOn(condition, harness));
      // A condition's subagent model takes the row's place; a row on that model already runs it.
      const named = condition?.subagent;
      if (!harnesses.length || named?.catalogId === model.id) return [];
      const delegated = named
        ? conditionSubagent(
            { ...named, credentialId: subagentCredentialId },
            { name: condition.name, harnesses, model, provider: route.provider },
            serving,
          )
        : subagent;
      // Only the gateway can serve and price a second model: a direct trial reaches one endpoint.
      if (
        delegated &&
        harnesses.some(
          (harness) =>
            trialRoute({ modelName, credentials: runCredentials }, harness) !== "gateway",
        )
      )
        throw new Error(SUBAGENT_NEEDS_GATEWAY);
      return selection.skipCompleted
        ? harnesses.map((harness) => ({
            condition,
            subagent: delegated,
            harnesses: [harness],
            tasks: tasks.filter(
              (task) =>
                !completed.has(
                  configurationTaskKey(
                    configurationIdentity(modelIdentity, thinking, harness, {
                      condition: condition?.id,
                      subagent: delegated,
                    }),
                    task.runId,
                    task.taskId,
                  ),
                ),
            ),
          }))
        : [{ condition, subagent: delegated, harnesses, tasks }];
    });
    const { pricing } = route;
    return groups
      .filter((group) => group.tasks.length > 0 && group.harnesses.length > 0)
      .map(
        (group): EvaluationInput => ({
          id: randomUUID(),
          ...owner.scope,
          ...(group.condition ? { condition: group.condition } : {}),
          model: model.id,
          modelName,
          thinking,
          ...(group.subagent ? { subagent: group.subagent } : {}),
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
          credentials: runCredentials,
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
      inputs: resourceWarnings.length
        ? inputs.map((input) => ({ ...input, resourceWarnings }))
        : inputs,
    }),
  );
}

/** The longest of the tasks' own limits, for registry tasks, which run with them. */
function taskMinutes(tasks: EvaluationInput["tasks"]): { taskMinutes?: number } {
  const minutes = tasks.flatMap((task) => (task.minutes ? [task.minutes] : []));
  return minutes.length ? { taskMinutes: Math.max(...minutes) } : {};
}
