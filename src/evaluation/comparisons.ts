import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import { modelIdPattern, thinkingLevels } from "../contracts/models.js";
import type { Benchmark } from "../db/benchmarks.js";
import type { ComparisonRecord } from "../db/comparisons.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { TaskStore } from "../db/tasks.js";
import type { Vault } from "../db/vault.js";
import type { ManagedOffer } from "../generation/billing/managed.js";
import { mergeJudgeNeeds } from "../harnesses/harbor/host-variables.js";
import type { runCommand } from "../lib/process.js";
import { hostedSandboxes } from "./catalog.js";
import { comparisonProgress } from "./comparison-progress.js";
import { type ComparisonOwner, saveComparison } from "./comparison-save.js";
import { freezeRegistryTasks, repositoryTasks } from "./frozen-tasks.js";
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
          harnesses: z.array(z.enum(harnessIds)).min(1).max(harnessIds.length),
        })
        .strict(),
    )
    .min(1)
    .max(12),
  sandbox: z.enum(["managed", ...hostedSandboxes]),
  sandboxCredentialId: z.union([z.uuid(), z.literal("managed-sandbox")]),
  skipCompleted: z.boolean().optional(),
};
const comparisonSelection = z.object(selectionFields).strict();
export type ComparisonSelection = z.infer<typeof comparisonSelection>;

/** A repository's comparison: its approved tasks. */
export const comparisonSchema = z
  .object({
    ...selectionFields,
    tasks: z
      .array(
        z
          .object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ComparisonDraft = z.infer<typeof comparisonSchema>;

/**
 * A benchmark's comparison: its dataset is the benchmark's, so it picks models, and the credential
 * its tasks' LLM judge calls with when they have one.
 */
export const benchmarkComparisonSchema = z
  .object({ ...selectionFields, judgeCredentialId: z.uuid().optional() })
  .strict();
export type BenchmarkComparisonDraft = z.infer<typeof benchmarkComparisonSchema>;

export type { ComparisonOwner } from "./comparison-save.js";

export async function createComparison(
  vault: Pick<Vault, "credentials" | "comparisons">,
  tasks: TaskStore,
  store: ArtifactStore,
  managed: ManagedOffer,
  owner: ComparisonOwner & { scope: { repoId: number } },
  draft: ComparisonDraft,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<ComparisonRecord> {
  const selection = comparisonSchema.parse(draft);
  return saveComparison(
    vault,
    store,
    managed,
    owner,
    selection,
    JSON.stringify(selection),
    () => repositoryTasks(tasks, owner.scope.repoId, selection.tasks),
    environment,
    fetcher,
  );
}

/**
 * Saves a benchmark's comparison. Its dataset is downloaded, checked, and frozen once the rest of
 * the selection checks out (freezeRegistryTasks), so its trials run exactly what was checked.
 */
export async function createBenchmarkComparison(
  vault: Pick<Vault, "credentials" | "comparisons">,
  store: ArtifactStore,
  managed: ManagedOffer,
  owner: ComparisonOwner & { scope: { benchmarkId: number } },
  benchmark: Pick<Benchmark, "name" | "ref">,
  draft: BenchmarkComparisonDraft,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  registryCommand?: typeof runCommand,
): Promise<ComparisonRecord> {
  const selection = benchmarkComparisonSchema.parse(draft);
  return saveComparison(
    vault,
    store,
    managed,
    owner,
    selection,
    JSON.stringify(selection),
    () =>
      freezeRegistryTasks(
        store,
        [`${benchmark.name}@${benchmark.ref}`],
        environment,
        registryCommand,
      ),
    environment,
    fetcher,
    (tasks, saved) => judgeCredential(tasks, saved, selection.judgeCredentialId),
  );
}

/**
 * The credential a benchmark's LLM judge calls with: an API key whose provider gives the judge
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
  const refusal = judgeCredentialRefusal(credential, needs);
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
      const run = await getEvaluation(store, comparison.scope, input.id);
      if (!run || run.status === "queued" || run.status === "running")
        throw new Error("Credential is needed by an active or pending comparison");
    }
  }
}
