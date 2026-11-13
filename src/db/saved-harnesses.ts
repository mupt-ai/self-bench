import { and, asc, eq } from "drizzle-orm";
import type { SavedHarnessDraft } from "../contracts/saved-harnesses.js";
import type { Database } from "./client.js";
import { savedHarnesses, users } from "./schema.js";

/** A saved harness (saved-harness-schema.ts) as the API returns it. */
export interface SavedHarness extends SavedHarnessDraft {
  readonly id: number;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Thrown when a workspace already has a harness of that name; answered with a 409. */
export class HarnessNameTaken extends Error {
  constructor(name: string) {
    super(`A harness named ${name} already exists`);
  }
}

/** Its changes, with the agent named `agent`: rows saved before the rename name it `harness`. */
function agentNamed(changes: Record<string, unknown>): Omit<SavedHarnessDraft, "name"> {
  const { harness, ...rest } = changes;
  return (
    harness !== undefined && rest.agent === undefined ? { ...rest, agent: harness } : rest
  ) as Omit<SavedHarnessDraft, "name">;
}

export function createSavedHarnessStore(db: Database) {
  const select = () =>
    db
      .select({ harness: savedHarnesses, createdBy: users.login })
      .from(savedHarnesses)
      .leftJoin(users, eq(users.id, savedHarnesses.createdBy));
  const view = ({
    harness,
    createdBy,
  }: {
    harness: typeof savedHarnesses.$inferSelect;
    createdBy: string | null;
  }): SavedHarness => ({
    id: harness.id,
    name: harness.name,
    ...agentNamed(harness.changes),
    // Rows written before a field existed, or by hand, may omit it; the schema's default is [].
    skills: harness.changes.skills ?? [],
    ...(createdBy ? { createdBy } : {}),
    createdAt: harness.createdAt.toISOString(),
    updatedAt: harness.updatedAt.toISOString(),
  });
  const find = async (orgId: number, id: number): Promise<SavedHarness | undefined> => {
    const [row] = await select().where(
      and(eq(savedHarnesses.orgId, orgId), eq(savedHarnesses.id, id)),
    );
    return row ? view(row) : undefined;
  };
  /** Runs a write, naming the harness whose name the workspace's unique index refused. */
  const named = async <Result>(name: string, write: () => Promise<Result>): Promise<Result> => {
    try {
      return await write();
    } catch (error) {
      // The table's only unique index beside its key is the workspace's names.
      const code = (error as { code?: unknown }).code;
      const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
      if (code === "23505" || causeCode === "23505") throw new HarnessNameTaken(name);
      throw error;
    }
  };
  return {
    find,
    /** A workspace's saved harnesses, by name. */
    async list(orgId: number): Promise<SavedHarness[]> {
      const rows = await select()
        .where(eq(savedHarnesses.orgId, orgId))
        .orderBy(asc(savedHarnesses.name), asc(savedHarnesses.id));
      return rows.map(view);
    },
    async create(
      orgId: number,
      { name, ...changes }: SavedHarnessDraft,
      userId?: number,
    ): Promise<SavedHarness> {
      const [created] = await named(name, () =>
        db
          .insert(savedHarnesses)
          .values({ orgId, name, changes, ...(userId !== undefined ? { createdBy: userId } : {}) })
          .returning({ id: savedHarnesses.id }),
      );
      const found = created && (await find(orgId, created.id));
      if (!found) throw new Error("Harness was not saved");
      return found;
    },
    /** Replaces one's name and changes; undefined when the workspace has no such harness. */
    async update(
      orgId: number,
      id: number,
      { name, ...changes }: SavedHarnessDraft,
    ): Promise<SavedHarness | undefined> {
      await named(name, () =>
        db
          .update(savedHarnesses)
          .set({ name, changes, updatedAt: new Date() })
          .where(and(eq(savedHarnesses.orgId, orgId), eq(savedHarnesses.id, id))),
      );
      return find(orgId, id);
    },
    /** Whether it was there to remove. */
    async remove(orgId: number, id: number): Promise<boolean> {
      const removed = await db
        .delete(savedHarnesses)
        .where(and(eq(savedHarnesses.orgId, orgId), eq(savedHarnesses.id, id)))
        .returning({ id: savedHarnesses.id });
      return removed.length > 0;
    },
  };
}
export type SavedHarnessStore = ReturnType<typeof createSavedHarnessStore>;
