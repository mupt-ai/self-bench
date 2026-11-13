import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import { comparisonConditionSchema, MAX_CONDITIONS, MAX_PICKED } from "../contracts/conditions.js";
import { modelIdPattern, thinkingLevels } from "../contracts/models.js";
import type { ComparisonRecord } from "../db/comparisons.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { Vault } from "../db/vault.js";
import type { ManagedOffer } from "../generation/billing/managed.js";
import { mergeJudgeNeeds } from "../harnesses/harbor/host-variables.js";
import { hostedSandboxes } from "./catalog.js";
import { comparisonProgress } from "./comparison-progress.js";
import { type ComparisonOwner, saveComparison } from "./comparison-save.js";
import type { EvaluationDataset } from "./dataset.js";
import { judgeCredentialRefusal } from "./judge.js";
import { harnessIds } from "./models.js";
import { getEvaluation } from "./store.js";
import type { EvaluationInput } from "./types.js";

/** What every comparison selects besides its tasks: models, harnesses, and where they run. */
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
  conditions: z.array(comparisonConditionSchema).max(MAX_CONDITIONS).optional(),
  /**
   * Whether the tasks also run as they are, in no environment: with no harness change, or with a
   * row's saved harness. Default true.
   */
  baseline: z.boolean().optional(),
};
const comparisonSelection = z.object(selectionFields).strict();
export type ComparisonSelection = z.infer<typeof comparisonSelection>;

/**
 * A comparison: models over the tasks it picks from its repository or benchmark (every task when
 * it names none), and the credential their LLM judge calls with when they have one.
 */
export const comparisonSchema = z
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
export type ComparisonDraft = z.infer<typeof comparisonSchema>;

export type { ComparisonOwner } from "./comparison-save.js";

/**
 * Saves a comparison of the draft's models over the tasks it picks from `dataset`, frozen as the
 * dataset gives them now.
 */
export async function createComparison(
  vault: Pick<Vault, "credentials" | "comparisons" | "harnesses">,
  dataset: Pick<EvaluationDataset, "select" | "environment">,
  store: ArtifactStore,
  managed: ManagedOffer,
  owner: ComparisonOwner,
  draft: ComparisonDraft,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ComparisonRecord> {
  const selection = comparisonSchema.parse(draft);
  return saveComparison(
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

export async function comparisonStatus(store: ArtifactStore, record: ComparisonRecord) {
  const runs = await Promise.all(
    record.inputs.map((input) => getEvaluation(store, record.scope, input.id)),
  );
  return comparisonProgress(
    record,
    new Map(runs.flatMap((run) => (run ? [[run.id, run] as const] : []))),
  );
}
export async function dispatchComparison(
  store: ArtifactStore,
  record: ComparisonRecord,
  start: (input: EvaluationInput) => Promise<void>,
) {
  for (const input of record.inputs) {
    const run = await getEvaluation(store, record.scope, input.id);
    if (!run || run.status === "queued") await start(input);
  }
}

/**
 * A credential cannot be deleted while a comparison that uses it (for its model, its sandbox, or
 * its LLM judge) still has runs to start.
 */
export async function assertCredentialUnused(
  comparisons: Vault["comparisons"],
  store: ArtifactStore,
  orgId: number,
  id: string,
) {
  for (const comparison of await comparisons.listForOrg(orgId)) {
    const uses = comparison.inputs.filter(
      ({ credentials, subagent }) =>
        subagent?.credentialId === id ||
        credentials?.modelCredentialId === id ||
        credentials?.sandboxCredentialId === id ||
        credentials?.judgeCredentialId === id,
    );
    if (await unfinished(store, { ...comparison, inputs: uses }))
      throw new Error("Credential is needed by an active or pending comparison");
  }
}

/** Whether any of a comparison's runs has yet to start or finish (one never started counts). */
export async function unfinished(
  store: ArtifactStore,
  comparison: Pick<ComparisonRecord, "scope" | "inputs">,
): Promise<boolean> {
  for (const input of comparison.inputs) {
    const run = await getEvaluation(store, comparison.scope, input.id);
    if (!run || run.status === "queued" || run.status === "running") return true;
  }
  return false;
}
