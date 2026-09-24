import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import { thinkingLevels } from "../contracts/models.js";
import type { ComparisonRecord } from "../db/comparisons.js";
import { runnable } from "../db/task-record.js";
import type { TaskStore } from "../db/tasks.js";
import type { Vault } from "../db/vault.js";
import { type ManagedOffer, managedHarborEnvironment } from "../generation/billing/managed.js";
import { type CatalogModel, catalog, hostedSandboxes } from "./catalog.js";
import {
  evaluationTaskKey,
  harnessIds,
  modelIdPattern,
  routeFor,
  thinkingOptions,
} from "./models.js";
import { getEvaluation, listEvaluations } from "./store.js";
import type { EvaluationInput } from "./types.js";

export const comparisonSchema = z
  .object({
    id: z.uuid(),
    tasks: z
      .array(
        z
          .object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) })
          .strict(),
      )
      .min(1),
    models: z
      .array(
        z
          .object({
            catalogId: z.string().max(80),
            customModel: z.string().regex(modelIdPattern).optional(),
            credentialId: z.union([z.uuid(), z.literal("managed-model")]),
            thinking: z.enum(thinkingLevels).optional(),
            harnesses: z.array(z.enum(harnessIds)).min(1).max(harnessIds.length),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    sandbox: z.enum(["managed", ...hostedSandboxes]),
    sandboxCredentialId: z.union([z.uuid(), z.literal("managed-sandbox")]),
    skipCompleted: z.boolean().optional(),
  })
  .strict();
export type ComparisonDraft = z.infer<typeof comparisonSchema>;
export interface ComparisonScope {
  repoId: number;
  orgId: number;
  tenant: string;
  login: string;
}
export async function createComparison(
  { credentials, comparisons }: Pick<Vault, "credentials" | "comparisons">,
  tasks: TaskStore,
  store: ArtifactStore,
  managed: ManagedOffer,
  scope: ComparisonScope,
  draft: ComparisonDraft,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ComparisonRecord> {
  const selection = comparisonSchema.parse(draft);
  const signature = JSON.stringify(selection);
  const previous = await comparisons.find(selection.id);
  if (previous) {
    if (
      previous.orgId !== scope.orgId ||
      previous.repoId !== scope.repoId ||
      previous.signature !== signature
    )
      throw new Error("Comparison ID belongs to a different selection");
    return previous;
  }
  if (
    new Set(selection.tasks.map((task) => evaluationTaskKey(task.runId, task.taskId))).size !==
    selection.tasks.length
  )
    throw new Error("Duplicate task selection");
  const bundles = await Promise.all(
    selection.tasks.map((task) => tasks.find(scope.repoId, task.runId, task.taskId)),
  );
  if (bundles.some((task) => !task || !runnable(task)))
    throw new Error("Every task must be human-approved in this repository");
  const frozen = bundles.map((task) => {
    if (!task?.bundleKey) throw new Error("Task bundle unavailable");
    return { runId: task.runId, taskId: task.taskId, bundleKey: task.bundleKey };
  });
  const completed = selection.skipCompleted
    ? completedConfigurationTasks(await listEvaluations(store, scope.repoId))
    : new Set<string>();
  if ((await comparisons.countForOrg(scope.orgId)) >= 500)
    throw new Error("Comparison retention limit reached; contact an operator");
  const saved = new Map(
    (await credentials.list(scope.orgId)).map((credential) => [credential.id, credential]),
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
  const seen = new Set<string>();
  const createdAt = new Date().toISOString();
  const inputs: EvaluationInput[] = selection.models.flatMap((selected) => {
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
        : catalog.find((entry) => entry.id === selected.catalogId);
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
    if (
      credential.auth === "codex-login" &&
      selected.harnesses.some((harness) => harness !== "codex")
    )
      throw new Error("Codex sign-in can only be used with the Codex harness");
    if (
      selected.harnesses.some((harness) => !route.harnesses.includes(harness)) ||
      new Set(selected.harnesses).size !== selected.harnesses.length
    )
      throw new Error("Unsupported or repeated harness");
    const levels = thinkingOptions(model, selected.harnesses);
    const thinking = selected.thinking ?? (levels.includes("high") ? "high" : "default");
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
    return groups
      .filter((group) => group.tasks.length > 0)
      .map(
        (group): EvaluationInput => ({
          id: randomUUID(),
          model: model.id,
          modelName,
          thinking,
          harnesses: group.harnesses,
          sandbox: selection.sandbox === "managed" ? "modal" : selection.sandbox,
          tasks: group.tasks,
          repoId: scope.repoId,
          tenant: scope.tenant,
          startedBy: scope.login,
          createdAt,
          ...(route.pricing ? { pricing: route.pricing } : {}),
          credentialOrgId: scope.orgId,
          comparisonId: selection.id,
          credentials: {
            modelCredentialId: credential.id,
            sandboxCredentialId: sandbox.id,
            provider: route.provider,
          },
        }),
      );
  });
  if (inputs.length === 0)
    throw new Error("Every selected configuration and task already has a completed result.");
  const record = await comparisons.insert({
    id: selection.id,
    orgId: scope.orgId,
    repoId: scope.repoId,
    createdAt,
    signature,
    inputs,
  });
  if (
    record.orgId !== scope.orgId ||
    record.repoId !== scope.repoId ||
    record.signature !== signature
  )
    throw new Error("Comparison ID belongs to a different selection");
  return record;
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

export async function comparisonStatus(store: ArtifactStore, record: ComparisonRecord) {
  const runs = await Promise.all(
    record.inputs.map(async (input) => {
      const run = await getEvaluation(store, record.repoId, input.id);
      return {
        id: input.id,
        model: input.modelName,
        thinking: input.thinking,
        harnesses: input.harnesses,
        status: run?.status ?? "pending",
        completed:
          run?.trials.filter((trial) => trial.status === "completed" || trial.status === "failed")
            .length ?? 0,
        trials: input.tasks.length * input.harnesses.length,
      };
    }),
  );
  return { id: record.id, createdAt: record.createdAt, runs };
}
export async function dispatchComparison(
  store: ArtifactStore,
  record: ComparisonRecord,
  start: (input: EvaluationInput) => Promise<void>,
) {
  for (const input of record.inputs) {
    const run = await getEvaluation(store, record.repoId, input.id);
    if (!run || run.status === "queued") await start(input);
  }
}

/** A credential cannot be deleted while a comparison that uses it still has runs to start. */
export async function assertCredentialUnused(
  comparisons: Vault["comparisons"],
  store: ArtifactStore,
  orgId: number,
  id: string,
) {
  for (const comparison of await comparisons.listForOrg(orgId)) {
    for (const input of comparison.inputs) {
      if (
        input.credentials?.modelCredentialId !== id &&
        input.credentials?.sandboxCredentialId !== id
      )
        continue;
      const run = await getEvaluation(store, input.repoId, input.id);
      if (!run || run.status === "queued" || run.status === "running")
        throw new Error("Credential is needed by an active or pending comparison");
    }
  }
}
