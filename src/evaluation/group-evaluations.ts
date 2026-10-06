import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import { AGENT_MINUTES } from "../contracts/agent-limit.js";
import type { ComparisonStore } from "../db/comparisons.js";
import type {
  GroupEvaluationMember,
  GroupEvaluationRecord,
  RepoGroup,
  RepoGroupStore,
} from "../db/repo-groups.js";
import { runnable } from "../db/task-record.js";
import type { TaskStore } from "../db/tasks.js";
import type { Vault } from "../db/vault.js";
import type { ManagedOffer } from "../generation/billing/managed.js";
import { cancelComparison, type StopEvaluation } from "./cancel.js";
import { comparisonProgress } from "./comparison-progress.js";
import { comparisonSchema, createComparison, dispatchComparison } from "./comparisons.js";
import { listRuns } from "./run-list.js";
import type { EvaluationInput } from "./types.js";

/**
 * A comparison's settings without its tasks: each repository of the group runs them on every
 * task approved there when the evaluation is submitted, all with the same agent minutes.
 */
export const groupEvaluationSchema = comparisonSchema
  .omit({ tasks: true, skipCompleted: true })
  .extend({ agentMinutes: z.number().int().min(AGENT_MINUTES.min).max(AGENT_MINUTES.max) })
  .strict();
export type GroupEvaluationDraft = z.infer<typeof groupEvaluationSchema>;

interface GroupScope {
  orgId: number;
  tenant: string;
  login: string;
}

/** The comparison a group evaluation gives a repository: the same on every retry of it. */
function childId(id: string, repoId: number): string {
  const hex = createHash("sha256").update(`${id}/${repoId}`).digest("hex");
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Saves a group evaluation, which fixes each member's tasks and comparison ID, then a comparison
 * per member with approved tasks. A retry with the same ID, or a resume, saves any comparison a
 * failed attempt left out, from the same tasks. A member with no approved tasks is left out.
 * `unsaved` says which comparisons could not be saved; the others still run.
 */
export async function createGroupEvaluation(
  vault: Pick<Vault, "credentials" | "comparisons">,
  groups: RepoGroupStore,
  tasks: TaskStore,
  store: ArtifactStore,
  managed: ManagedOffer,
  scope: GroupScope,
  group: RepoGroup,
  draft: GroupEvaluationDraft,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ record: GroupEvaluationRecord; unsaved?: string }> {
  const selection = groupEvaluationSchema.parse(draft);
  const signature = JSON.stringify({ groupId: group.id, ...selection });
  const owned = (record: GroupEvaluationRecord | undefined) => {
    if (
      !record ||
      record.orgId !== scope.orgId ||
      record.groupId !== group.id ||
      record.signature !== signature
    )
      throw new Error("Group evaluation ID belongs to a different selection");
    return record;
  };
  const save = (record: GroupEvaluationRecord) =>
    saveComparisons(vault, tasks, store, managed, scope, record, environment);
  const previous = await groups.findEvaluation(selection.id);
  if (previous) {
    const record = owned(previous);
    return { record, ...(await save(record)) };
  }
  if (group.repos.length === 0) throw new Error("Add a repository to this group first");
  const members = await Promise.all(
    group.repos.map(async (repo): Promise<GroupEvaluationMember> => {
      const selected = (await tasks.listForRepo(repo.id))
        .filter(runnable)
        .map(({ runId, taskId }) => ({ runId, taskId }))
        .sort((a, b) => a.runId.localeCompare(b.runId) || a.taskId.localeCompare(b.taskId));
      const member = { repoId: repo.id, fullName: repo.fullName };
      return selected.length
        ? { ...member, comparisonId: childId(selection.id, repo.id), tasks: selected }
        : { ...member, skipped: "No approved tasks" };
    }),
  );
  if (!members.some((member) => "comparisonId" in member))
    throw new Error("No repository in this group has approved tasks");
  const value: GroupEvaluationRecord = {
    id: selection.id,
    orgId: scope.orgId,
    groupId: group.id,
    groupName: group.name,
    signature,
    repos: members,
    createdByLogin: scope.login,
    createdAt: new Date().toISOString(),
  };
  const inserted = await groups.insertEvaluation(value);
  // A concurrent request with the same ID saved it first: finish that one.
  const record = inserted ? value : owned(await groups.findEvaluation(selection.id));
  const { unsaved, reasons } = await save(record);
  // Settings that cannot run fail every comparison: drop the evaluation this request created,
  // as nothing of it is left to resume.
  if (unsaved && inserted && (await childrenOf(vault.comparisons, record)).length === 0) {
    await groups.removeEvaluation(record.id);
    throw new Error(reasons[0]);
  }
  return { record, ...(unsaved ? { unsaved } : {}) };
}

/**
 * Saves the comparisons a group evaluation lists and has not saved yet, each on its own, so one
 * that cannot be saved holds back none of the others. Says which could not be saved, and why.
 */
export async function saveComparisons(
  vault: Pick<Vault, "credentials" | "comparisons">,
  tasks: TaskStore,
  store: ArtifactStore,
  managed: ManagedOffer,
  scope: GroupScope,
  record: GroupEvaluationRecord,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ unsaved?: string; reasons: string[] }> {
  const { agentMinutes, ...settings } = groupEvaluationSettings(record);
  const missing = [];
  for (const member of record.repos)
    if ("comparisonId" in member && !(await vault.comparisons.find(member.comparisonId)))
      missing.push(member);
  if (missing.length === 0) return { reasons: [] };
  const failed: { fullName: string; reason: string }[] = [];
  if ((await vault.comparisons.countForOrg(scope.orgId)) + missing.length > 500)
    failed.push(
      ...missing.map(({ fullName }) => ({
        fullName,
        reason: "Comparison retention limit reached; contact an operator",
      })),
    );
  else
    for (const member of missing) {
      try {
        await createComparison(
          vault,
          tasks,
          store,
          managed,
          { ...scope, login: record.createdByLogin, repoId: member.repoId, agentMinutes },
          { ...settings, id: member.comparisonId, tasks: member.tasks },
          environment,
        );
      } catch (error) {
        failed.push({
          fullName: member.fullName,
          reason: error instanceof Error ? error.message : "Comparison could not be saved",
        });
      }
    }
  if (failed.length === 0) return { reasons: [] };
  return {
    unsaved: `Not saved for ${failed.map(({ fullName, reason }) => `${fullName} (${reason})`).join(", ")}. Resume to retry them.`,
    reasons: failed.map(({ reason }) => reason),
  };
}

/** The comparisons a group evaluation saved, with the repositories they belong to. */
async function childrenOf(comparisons: ComparisonStore, record: GroupEvaluationRecord) {
  const found = await Promise.all(
    record.repos.map((member) =>
      "comparisonId" in member ? comparisons.find(member.comparisonId) : undefined,
    ),
  );
  return found.filter((comparison) => comparison !== undefined);
}

export async function dispatchGroupEvaluation(
  store: ArtifactStore,
  comparisons: ComparisonStore,
  record: GroupEvaluationRecord,
  start: (input: EvaluationInput) => Promise<void>,
) {
  for (const comparison of await childrenOf(comparisons, record))
    await dispatchComparison(store, comparison, start);
}

export async function cancelGroupEvaluation(
  store: ArtifactStore,
  comparisons: ComparisonStore,
  record: GroupEvaluationRecord,
  login: string,
  stop: StopEvaluation,
) {
  for (const comparison of await childrenOf(comparisons, record))
    await cancelComparison(store, comparison, login, stop);
}

/** The settings a group evaluation ran, as submitted. */
export function groupEvaluationSettings(record: GroupEvaluationRecord) {
  const {
    groupId: _,
    id: __,
    ...settings
  } = JSON.parse(record.signature) as GroupEvaluationDraft & {
    groupId: string;
  };
  return settings;
}

/**
 * A group evaluation with each repository's progress and the run summaries of its comparison:
 * what the page needs to compare repositories, and only this evaluation's runs, so a later run
 * in one repository never changes it.
 */
export async function groupEvaluationDetail(
  store: ArtifactStore,
  comparisons: ComparisonStore,
  record: GroupEvaluationRecord,
) {
  const children = new Map(
    (await childrenOf(comparisons, record)).map((comparison) => [comparison.id, comparison]),
  );
  return {
    id: record.id,
    groupId: record.groupId,
    groupName: record.groupName,
    createdAt: record.createdAt,
    createdBy: record.createdByLogin,
    settings: groupEvaluationSettings(record),
    repos: await Promise.all(
      record.repos.map(async (member) => {
        const comparison = "comparisonId" in member ? children.get(member.comparisonId) : undefined;
        if ("skipped" in member) return { fullName: member.fullName, skipped: member.skipped };
        if (!comparison) return { fullName: member.fullName, unsaved: true as const };
        const ids = new Set(comparison.inputs.map((input) => input.id));
        const { runs = [] } = await listRuns(store, member.repoId);
        const own = runs.filter((run) => ids.has(run.id));
        return {
          fullName: member.fullName,
          comparisonId: comparison.id,
          progress: comparisonProgress(comparison, new Map(own.map((run) => [run.id, run]))),
          runs: own,
        };
      }),
    ),
  };
}
