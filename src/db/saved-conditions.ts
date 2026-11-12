import { and, asc, eq } from "drizzle-orm";
import type { SavedConditionDraft } from "../contracts/conditions.js";
import type { Database } from "./client.js";
import { savedConditions, users } from "./schema.js";

/** A saved condition (condition-schema.ts) as the API returns it. */
export interface SavedCondition extends SavedConditionDraft {
  readonly id: number;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Thrown when a workspace already has a condition of that name; answered with a 409. */
export class ConditionNameTaken extends Error {
  constructor(name: string) {
    super(`A condition named ${name} already exists`);
  }
}

export function createSavedConditionStore(db: Database) {
  const select = () =>
    db
      .select({ condition: savedConditions, createdBy: users.login })
      .from(savedConditions)
      .leftJoin(users, eq(users.id, savedConditions.createdBy));
  const view = ({
    condition,
    createdBy,
  }: {
    condition: typeof savedConditions.$inferSelect;
    createdBy: string | null;
  }): SavedCondition => ({
    id: condition.id,
    name: condition.name,
    ...condition.changes,
    ...(createdBy ? { createdBy } : {}),
    createdAt: condition.createdAt.toISOString(),
    updatedAt: condition.updatedAt.toISOString(),
  });
  const find = async (orgId: number, id: number): Promise<SavedCondition | undefined> => {
    const [row] = await select().where(
      and(eq(savedConditions.orgId, orgId), eq(savedConditions.id, id)),
    );
    return row ? view(row) : undefined;
  };
  /** Runs a write, naming the condition whose name the workspace's unique index refused. */
  const named = async <Result>(name: string, write: () => Promise<Result>): Promise<Result> => {
    try {
      return await write();
    } catch (error) {
      // The table's only unique index beside its key is the workspace's names.
      const code = (error as { code?: unknown }).code;
      const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
      if (code === "23505" || causeCode === "23505") throw new ConditionNameTaken(name);
      throw error;
    }
  };
  return {
    find,
    /** A workspace's conditions, by name. */
    async list(orgId: number): Promise<SavedCondition[]> {
      const rows = await select()
        .where(eq(savedConditions.orgId, orgId))
        .orderBy(asc(savedConditions.name), asc(savedConditions.id));
      return rows.map(view);
    },
    async create(
      orgId: number,
      { name, ...changes }: SavedConditionDraft,
      userId?: number,
    ): Promise<SavedCondition> {
      const [created] = await named(name, () =>
        db
          .insert(savedConditions)
          .values({ orgId, name, changes, ...(userId !== undefined ? { createdBy: userId } : {}) })
          .returning({ id: savedConditions.id }),
      );
      const found = created && (await find(orgId, created.id));
      if (!found) throw new Error("Condition was not saved");
      return found;
    },
    /** Replaces one's name and changes; undefined when the workspace has no such condition. */
    async update(
      orgId: number,
      id: number,
      { name, ...changes }: SavedConditionDraft,
    ): Promise<SavedCondition | undefined> {
      await named(name, () =>
        db
          .update(savedConditions)
          .set({ name, changes, updatedAt: new Date() })
          .where(and(eq(savedConditions.orgId, orgId), eq(savedConditions.id, id))),
      );
      return find(orgId, id);
    },
    /** Whether it was there to remove. */
    async remove(orgId: number, id: number): Promise<boolean> {
      const removed = await db
        .delete(savedConditions)
        .where(and(eq(savedConditions.orgId, orgId), eq(savedConditions.id, id)))
        .returning({ id: savedConditions.id });
      return removed.length > 0;
    },
  };
}
export type SavedConditionStore = ReturnType<typeof createSavedConditionStore>;
