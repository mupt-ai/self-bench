import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client.js";
import { groupEvaluations, repoGroupMembers, repoGroups, repos } from "./schema.js";

/** At most this many groups per tenant, and repositories per group. */
const GROUP_LIMIT = 50;
const GROUP_REPO_LIMIT = 25;

export const repoGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    repos: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(GROUP_REPO_LIMIT),
  })
  .strict();

export interface RepoGroup {
  id: string;
  name: string;
  createdAt: string;
  /** Connected repositories, by name. */
  repos: { id: number; fullName: string }[];
}

/** A group member as a group evaluation submitted it: its comparison, or why it has none. */
export type GroupEvaluationMember = { repoId: number; fullName: string } & (
  | { comparisonId: string; tasks: { runId: string; taskId: string }[] }
  | { skipped: string }
);

export interface GroupEvaluationRecord {
  id: string;
  orgId: number;
  groupId: string;
  groupName: string;
  signature: string;
  repos: GroupEvaluationMember[];
  createdByLogin: string;
  createdAt: string;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A write's database error as the browser should read it: a name in use, or a repository gone. */
async function saving(write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    let cause: unknown = error;
    while (cause && typeof cause === "object" && !("code" in cause))
      cause = "cause" in cause ? cause.cause : undefined;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    if (code === "23505") throw new Error("A group with this name already exists");
    if (code === "23503") throw new Error("A repository is no longer connected; reload and retry");
    throw error;
  }
}

export function createRepoGroupStore(db: Database) {
  const membersOf = async (ids: string[]) => {
    const rows = ids.length
      ? await db
          .select({
            groupId: repoGroupMembers.groupId,
            id: repos.id,
            fullName: repos.fullName,
          })
          .from(repoGroupMembers)
          .innerJoin(repos, eq(repos.id, repoGroupMembers.repoId))
          .where(inArray(repoGroupMembers.groupId, ids))
          .orderBy(sql`lower(${repos.fullName})`)
      : [];
    return (groupId: string) =>
      rows.filter((row) => row.groupId === groupId).map(({ id, fullName }) => ({ id, fullName }));
  };
  const groupsOf = async (rows: (typeof repoGroups.$inferSelect)[]): Promise<RepoGroup[]> => {
    const members = await membersOf(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      repos: members(row.id),
    }));
  };
  const find = async (orgId: number, id: string): Promise<RepoGroup | undefined> => {
    const rows = await db
      .select()
      .from(repoGroups)
      .where(and(eq(repoGroups.orgId, orgId), eq(repoGroups.id, id)));
    return (await groupsOf(rows))[0];
  };
  const setMembers = async (tx: Transaction, groupId: string, repoIds: readonly number[]) => {
    await tx.delete(repoGroupMembers).where(eq(repoGroupMembers.groupId, groupId));
    if (repoIds.length)
      await tx
        .insert(repoGroupMembers)
        .values([...new Set(repoIds)].map((repoId) => ({ groupId, repoId })));
  };
  const evaluationOf = (row: typeof groupEvaluations.$inferSelect): GroupEvaluationRecord => ({
    ...row,
    repos: row.repos as GroupEvaluationMember[],
    createdAt: row.createdAt.toISOString(),
  });
  const findEvaluation = async (id: string) => {
    const [row] = await db.select().from(groupEvaluations).where(eq(groupEvaluations.id, id));
    return row ? evaluationOf(row) : undefined;
  };
  return {
    find,
    /** A tenant's groups, by name. */
    async list(orgId: number): Promise<RepoGroup[]> {
      const rows = await db
        .select()
        .from(repoGroups)
        .where(eq(repoGroups.orgId, orgId))
        .orderBy(asc(sql`lower(${repoGroups.name})`));
      return groupsOf(rows);
    },
    async create(orgId: number, name: string, repoIds: readonly number[]): Promise<RepoGroup> {
      const [total] = await db
        .select({ value: count() })
        .from(repoGroups)
        .where(eq(repoGroups.orgId, orgId));
      if ((total?.value ?? 0) >= GROUP_LIMIT) throw new Error("Repository group limit reached");
      const id = randomUUID();
      await saving(() =>
        db.transaction(async (tx) => {
          await tx.insert(repoGroups).values({ id, orgId, name });
          await setMembers(tx, id, repoIds);
        }),
      );
      const group = await find(orgId, id);
      if (!group) throw new Error("Repository group could not be saved");
      return group;
    },
    /** Renames a group and replaces its members; undefined when it is not this tenant's. */
    async update(orgId: number, id: string, name: string, repoIds: readonly number[]) {
      if (!(await find(orgId, id))) return undefined;
      await saving(() =>
        db.transaction(async (tx) => {
          await tx.update(repoGroups).set({ name }).where(eq(repoGroups.id, id));
          await setMembers(tx, id, repoIds);
        }),
      );
      return find(orgId, id);
    },
    /** True when a group was removed. Its evaluations, and their comparisons, stay. */
    async remove(orgId: number, id: string): Promise<boolean> {
      const rows = await db
        .delete(repoGroups)
        .where(and(eq(repoGroups.orgId, orgId), eq(repoGroups.id, id)))
        .returning({ id: repoGroups.id });
      return rows.length > 0;
    },
    findEvaluation,
    /** A group's evaluations, newest first. */
    async listEvaluations(orgId: number, groupId: string): Promise<GroupEvaluationRecord[]> {
      const rows = await db
        .select()
        .from(groupEvaluations)
        .where(and(eq(groupEvaluations.orgId, orgId), eq(groupEvaluations.groupId, groupId)))
        .orderBy(desc(groupEvaluations.createdAt));
      return rows.map(evaluationOf);
    },
    /** Inserts once; false when a record with its ID was already saved. */
    async insertEvaluation(value: GroupEvaluationRecord): Promise<boolean> {
      const rows = await db
        .insert(groupEvaluations)
        .values({ ...value, createdAt: new Date(value.createdAt) })
        .onConflictDoNothing()
        .returning({ id: groupEvaluations.id });
      return rows.length > 0;
    },
  };
}
export type RepoGroupStore = ReturnType<typeof createRepoGroupStore>;
