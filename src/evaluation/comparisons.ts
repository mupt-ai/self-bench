import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts.js";
import type { TaskStore } from "../site/task-store.js";
import { type ComparisonRecord, readAccount, updateAccount } from "./account.js";
import { type CatalogModel, catalog, hostedSandboxes } from "./catalog.js";
import type { EncryptedRecordStore } from "./encrypted-records.js";
import { routeFor, thinkingLevels, thinkingOptions } from "./model-options.js";
import { modelIdPattern } from "./providers.js";
import { getEvaluation } from "./store.js";
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
      .min(1)
      .max(10),
    models: z
      .array(
        z
          .object({
            catalogId: z.string().max(80),
            customModel: z.string().regex(modelIdPattern).optional(),
            credentialId: z.uuid(),
            thinking: z.enum(thinkingLevels).optional(),
            harnesses: z
              .array(z.enum(["codex", "claude-code", "pi"]))
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    sandbox: z.enum(hostedSandboxes),
    sandboxCredentialId: z.uuid(),
  })
  .strict();
export type ComparisonDraft = z.infer<typeof comparisonSchema>;
export interface ComparisonScope {
  repoId: number;
  ownerId: number;
  tenant: string;
  login: string;
}
export async function createComparison(
  records: EncryptedRecordStore,
  tasks: TaskStore,
  scope: ComparisonScope,
  draft: ComparisonDraft,
): Promise<ComparisonRecord> {
  const selection = comparisonSchema.parse(draft);
  const signature = JSON.stringify(selection);
  const previous = (await readAccount(records, scope.ownerId)).comparisons.find(
    (entry) => entry.id === selection.id,
  );
  if (previous) {
    if (previous.repoId !== scope.repoId || previous.signature !== signature)
      throw new Error("Comparison ID belongs to a different selection");
    return previous;
  }
  if (
    new Set(selection.tasks.map((task) => `${task.runId}/${task.taskId}`)).size !==
    selection.tasks.length
  )
    throw new Error("Duplicate task selection");
  const bundles = await Promise.all(
    selection.tasks.map((task) => tasks.find(scope.repoId, task.runId, task.taskId)),
  );
  if (
    bundles.some(
      (task) =>
        !task?.bundleKey ||
        task.pipelineStatus !== "accepted" ||
        task.review?.decision !== "approve",
    )
  )
    throw new Error("Every task must be human-approved in this repository");
  const frozen = bundles.map((task) => {
    if (!task?.bundleKey) throw new Error("Task bundle unavailable");
    return { runId: task.runId, taskId: task.taskId, bundleKey: task.bundleKey };
  });
  return updateAccount(records, scope.ownerId, async (account) => {
    const existing = account.comparisons.find((entry) => entry.id === selection.id);
    if (existing) {
      if (existing.repoId !== scope.repoId || existing.signature !== signature)
        throw new Error("Comparison ID belongs to a different selection");
      return existing;
    }
    if (account.comparisons.length >= 500)
      throw new Error("Comparison retention limit reached; contact an operator");
    const sandbox = account.credentials.find(
      (entry) => entry.id === selection.sandboxCredentialId && !entry.deleted,
    );
    if (sandbox?.kind !== selection.sandbox)
      throw new Error("Select your saved sandbox credential");
    const seen = new Set<string>();
    const createdAt = new Date().toISOString();
    const inputs: EvaluationInput[] = selection.models.map((selected) => {
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
      const credential = account.credentials.find(
        (entry) => entry.id === selected.credentialId && !entry.deleted,
      );
      const route = credential ? routeFor(model, credential.kind) : undefined;
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
      const identity = `${model.provider}/${model.model}`;
      if (seen.has(identity)) throw new Error("Select each model once");
      seen.add(identity);
      return {
        id: randomUUID(),
        model: selected.catalogId,
        modelName: `${route.provider === "custom" ? "openai" : route.provider}/${route.model}`,
        thinking,
        harnesses: selected.harnesses,
        sandbox: selection.sandbox,
        tasks: frozen,
        repoId: scope.repoId,
        tenant: scope.tenant,
        startedBy: scope.login,
        createdAt,
        ...(route.pricing ? { pricing: route.pricing } : {}),
        credentialOwnerId: scope.ownerId,
        comparisonId: selection.id,
        credentials: {
          modelCredentialId: credential.id,
          sandboxCredentialId: sandbox.id,
          provider: route.provider,
        },
      };
    });
    const record: ComparisonRecord = {
      id: selection.id,
      repoId: scope.repoId,
      ownerId: scope.ownerId,
      createdAt,
      signature,
      inputs,
    };
    account.comparisons.push(record);
    return record;
  });
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
