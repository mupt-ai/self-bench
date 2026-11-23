import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import { MAX_CONDITIONS, MAX_PICKED, runBatchConditionSchema } from "../contracts/conditions.js";
import { modelIdPattern, thinkingLevels } from "../contracts/models.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { RunBatchRecord } from "../db/run-batches.js";
import type { Vault } from "../db/vault.js";
import type { ManagedOffer } from "../generation/billing/managed.js";
import { mergeJudgeNeeds } from "../harnesses/harbor/host-variables.js";
import { hostedSandboxes } from "./catalog.js";
import type { EvaluationDataset } from "./dataset.js";
import { judgeCredentialRefusal } from "./judge.js";
import { harnessIds } from "./models.js";
import { runBatchProgress } from "./run-batch-progress.js";
import { type RunBatchOwner, saveRunBatch } from "./run-batch-save.js";
import { getEvaluation } from "./store.js";
import type { EvaluationInput } from "./types.js";

/** What every batch selects besides its tasks: models, harnesses, and where they run. */
const selectionFields = {
  id: z.uuid(),
  models: z
    .array(
      z
        .object({
          catalogId: z.string().max(200),
          customModel: z.string().regex(modelIdPattern).optional(),
          credentialId: z.union([z.uuid(), z.literal("managed-model")]),
          thinking: z.enum(thinkingLevels).optional(),
          /**
           * A subagent model for this row alone, under the baseline and every condition that
           * names none: how runs named one before conditions did, which retries of them still do.
           */
          subagent: z
            .object({
              catalogId: z.string().min(1).max(200),
              credentialId: z.union([z.uuid(), z.literal("managed-model")]),
            })
            .strict()
            .optional(),
          harnesses: z.array(z.enum(harnessIds)).min(1).max(harnessIds.length),
          /**
           * One of the workspace's saved harnesses, by id, which this row runs in place of its
           * harness as it is: on the tasks as they are (unless `baseline` is false) and in each
           * environment. Its agent must be the row's harness.
           */
          harness: z.number().int().positive().optional(),
        })
        .strict(),
    )
    .min(1)
    .max(12),
  sandbox: z.enum(["managed", ...hostedSandboxes]),
  sandboxCredentialId: z.union([z.uuid(), z.literal("managed-sandbox")]),
  skipCompleted: z.boolean().optional(),
  /**
   * The workspace's saved harnesses, by id, and the repository's environments, by id. Every
   * configuration also runs every task with each harness, in each environment, and with each
   * harness in each environment.
   */
  harnesses: z.array(z.number().int().positive()).max(MAX_PICKED).optional(),
  environments: z.array(z.number().int().positive()).max(MAX_PICKED).optional(),
  /**
   * Pairs named one by one (conditions.ts): a saved harness and environment, or the changes
   * written out, as a retry repeats a run. What older clients send in place of the two lists.
   */
  conditions: z.array(runBatchConditionSchema).max(MAX_CONDITIONS).optional(),
  /**
   * Whether the tasks also run as they are, in no environment: with no harness change, or with a
   * row's saved harness. Default true.
   */
  baseline: z.boolean().optional(),
};
const runBatchSelection = z.object(selectionFields).strict();
export type RunBatchSelection = z.infer<typeof runBatchSelection>;

/**
 * A batch: models over the tasks it picks from its repository or benchmark (every task when
 * it names none), and the credential their LLM judge calls with when they have one.
 */
export const runBatchSchema = z
  .object({
    ...selectionFields,
    tasks: z
      .array(
        z
          .object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) })
          .strict(),
      )
      .min(1)
      .optional(),
    judgeCredentialId: z.uuid().optional(),
  })
  .strict();
export type RunBatchDraft = z.infer<typeof runBatchSchema>;

export type { RunBatchOwner } from "./run-batch-save.js";

/**
 * Saves a batch of the draft's models over the tasks it picks from `dataset`, frozen as the
 * dataset gives them now.
 */
export async function createRunBatch(
  vault: Pick<Vault, "credentials" | "batches" | "harnesses">,
  dataset: Pick<EvaluationDataset, "select" | "environment">,
  store: ArtifactStore,
  managed: ManagedOffer,
  owner: RunBatchOwner,
  draft: RunBatchDraft,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunBatchRecord> {
  const selection = runBatchSchema.parse(draft);
  return saveRunBatch(
    vault,
    store,
    managed,
    owner,
    selection,
    JSON.stringify(selection),
    () => dataset.select(selection.tasks),
    environment,
    (tasks, saved) => judgeCredential(tasks, saved, selection.judgeCredentialId),
    {
      environments: dataset.environment?.bind(dataset),
      saved: async (id) => vault.harnesses?.find(owner.orgId, id),
    },
  );
}

/**
 * The credential the tasks' LLM judge calls with: an API key whose provider gives the judge
 * variables the tasks read (judgeCredentialRefusal). None when no task has a judge.
 */
function judgeCredential(
  tasks: EvaluationInput["tasks"],
  saved: ReadonlyMap<string, CredentialInfo>,
  id: string | undefined,
): string | undefined {
  const needs = mergeJudgeNeeds(tasks.map((task) => task.judge));
  if (needs.variables.length === 0) return undefined;
  const credential = id ? saved.get(id) : undefined;
  if (!credential)
    throw new Error("These tasks grade with an LLM judge: select a judge credential");
  const refusal = judgeCredentialRefusal(credential);
  if (refusal) throw new Error(refusal);
  return credential.id;
}

export async function runBatchStatus(store: ArtifactStore, record: RunBatchRecord) {
  const runs = await Promise.all(
    record.inputs.map((input) => getEvaluation(store, record.scope, input.id)),
  );
  return runBatchProgress(
    record,
    new Map(runs.flatMap((run) => (run ? [[run.id, run] as const] : []))),
  );
}
export async function dispatchRunBatch(
  store: ArtifactStore,
  record: RunBatchRecord,
  start: (input: EvaluationInput) => Promise<void>,
) {
  for (const input of record.inputs) {
    const run = await getEvaluation(store, record.scope, input.id);
    if (!run || run.status === "queued") await start(input);
  }
}

/**
 * A credential cannot be deleted while a batch that uses it (for its model, its sandbox, or
 * its LLM judge) still has runs to start.
 */
export async function assertCredentialUnused(
  batches: Vault["batches"],
  store: ArtifactStore,
  orgId: number,
  id: string,
) {
  for (const batch of await batches.listForOrg(orgId)) {
    const uses = batch.inputs.filter(
      ({ credentials, subagent }) =>
        subagent?.credentialId === id ||
        credentials?.modelCredentialId === id ||
        credentials?.sandboxCredentialId === id ||
        credentials?.judgeCredentialId === id,
    );
    if (await unfinished(store, { ...batch, inputs: uses }))
      throw new Error("Credential is needed by an active or pending batch");
  }
}

/** Whether any of a batch's runs has yet to start or finish (one never started counts). */
export async function unfinished(
  store: ArtifactStore,
  batch: Pick<RunBatchRecord, "scope" | "inputs">,
): Promise<boolean> {
  for (const input of batch.inputs) {
    const run = await getEvaluation(store, batch.scope, input.id);
    if (!run || run.status === "queued" || run.status === "running") return true;
  }
  return false;
}
