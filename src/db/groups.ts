import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { repositoryGroups } from "./schema.js";

/** A workspace's repository group. */
export interface RepositoryGroup {
  readonly id: number;
  readonly orgId: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** A data URL image shown instead of the default mark; null for the default. */
  readonly logo: string | null;
  /** Members' GitHub repository ids, in the order pages list them. */
  readonly repositoryIds: readonly number[];
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a save sets: everything but who and when. */
export interface GroupFields {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** Left out (undefined) keeps the group's logo as it is. */
  readonly logo?: string | null | undefined;
  readonly repositoryIds: readonly number[];
}

/** The workspace already has a group at that address. */
export class GroupSlugTaken extends Error {}

const groupFrom = (row: typeof repositoryGroups.$inferSelect): RepositoryGroup => ({
  id: row.id,
  orgId: row.orgId,
  slug: row.slug,
  name: row.name,
  description: row.description,
  logo: row.logo,
  repositoryIds: row.repositoryIds,
  updatedBy: row.updatedByLogin,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
};

/** Runs a write, turning a clash on the workspace's addresses into `GroupSlugTaken`. */
async function claimingSlug<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error)) throw new GroupSlugTaken("That address is already in use");
    throw error;
  }
}

export function createGroupStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const bySlug = (orgId: number, slug: string) =>
    and(eq(repositoryGroups.orgId, orgId), eq(repositoryGroups.slug, slug));
  return {
    /** A workspace's groups, by name. */
    async list(orgId: number): Promise<RepositoryGroup[]> {
      const rows = await db
        .select()
        .from(repositoryGroups)
        .where(eq(repositoryGroups.orgId, orgId))
        .orderBy(asc(repositoryGroups.name), asc(repositoryGroups.slug));
      return rows.map(groupFrom);
    },
    async find(orgId: number, slug: string): Promise<RepositoryGroup | undefined> {
      const [row] = await db.select().from(repositoryGroups).where(bySlug(orgId, slug));
      return row ? groupFrom(row) : undefined;
    },
    async insert(
      orgId: number,
      fields: GroupFields,
      by: { readonly login: string },
    ): Promise<RepositoryGroup> {
      const at = now();
      const [row] = await claimingSlug(() =>
        db
          .insert(repositoryGroups)
          .values({
            orgId,
            ...fields,
            repositoryIds: [...fields.repositoryIds],
            updatedByLogin: by.login,
            createdAt: at,
            updatedAt: at,
          })
          .returning(),
      );
      if (!row) throw new Error("group insert returned no row");
      return groupFrom(row);
    },
    /** Saves a workspace's group; undefined when it has no group at `slug`. */
    async update(
      orgId: number,
      slug: string,
      fields: GroupFields,
      by: { readonly login: string },
    ): Promise<RepositoryGroup | undefined> {
      const [row] = await claimingSlug(() =>
        db
          .update(repositoryGroups)
          .set({
            ...fields,
            ...(fields.logo === undefined ? {} : { logo: fields.logo }),
            repositoryIds: [...fields.repositoryIds],
            updatedByLogin: by.login,
            updatedAt: now(),
          })
          .where(bySlug(orgId, slug))
          .returning(),
      );
      return row ? groupFrom(row) : undefined;
    },
    /** Deletes a workspace's group; its releases stay, as a repository's outlive it. */
    async remove(orgId: number, slug: string): Promise<RepositoryGroup | undefined> {
      const [row] = await db.delete(repositoryGroups).where(bySlug(orgId, slug)).returning();
      return row ? groupFrom(row) : undefined;
    },
  };
}
export type GroupStore = ReturnType<typeof createGroupStore>;
