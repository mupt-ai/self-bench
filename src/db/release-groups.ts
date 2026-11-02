import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { GroupRecord } from "../public/release-groups.js";
import type { Database } from "./client.js";
import { releaseGroups, releases } from "./schema.js";

/** A workspace's repository group, as the app edits it. */
export interface ReleaseGroupRow extends GroupRecord {
  readonly id: string;
  readonly orgId: number;
  readonly updatedByLogin: string;
  readonly createdAt: string;
}

/** What a save sets: everything but who and when. */
export interface GroupFields {
  readonly publisherLogin: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly repositoryIds: readonly number[];
}

/** The workspace already has a group at that address. */
export class GroupSlugTaken extends Error {}

const rowFrom = (row: typeof releaseGroups.$inferSelect): ReleaseGroupRow => ({
  id: row.id,
  orgId: row.orgId,
  publisherLogin: row.publisherLogin,
  slug: row.slug,
  name: row.name,
  description: row.description,
  repositoryIds: row.repositoryIds,
  updatedByLogin: row.updatedByLogin,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
};

/** Runs a write, turning a clash on the workspace's slugs into `GroupSlugTaken`. */
async function claimingSlug<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error)) throw new GroupSlugTaken("That address is already in use");
    throw error;
  }
}

export function createReleaseGroupStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const ofOrg = (orgId: number, id: string) =>
    and(eq(releaseGroups.orgId, orgId), eq(releaseGroups.id, id));
  return {
    /** A workspace's groups, by name. */
    async list(orgId: number): Promise<ReleaseGroupRow[]> {
      const rows = await db
        .select()
        .from(releaseGroups)
        .where(eq(releaseGroups.orgId, orgId))
        .orderBy(asc(releaseGroups.name), asc(releaseGroups.slug));
      return rows.map(rowFrom);
    },
    /** Every workspace's groups, for the public snapshot. */
    async all(): Promise<ReleaseGroupRow[]> {
      const [rows, logins] = await Promise.all([
        db.select().from(releaseGroups),
        db.selectDistinct({ orgId: releases.orgId, login: releases.publisherLogin }).from(releases),
      ]);
      return rows.map((row) => ({
        ...rowFrom(row),
        releaseLogins: logins.filter((each) => each.orgId === row.orgId).map((each) => each.login),
      }));
    },
    async insert(
      orgId: number,
      fields: GroupFields,
      by: { readonly login: string },
    ): Promise<ReleaseGroupRow> {
      const at = now();
      const [row] = await claimingSlug(() =>
        db
          .insert(releaseGroups)
          .values({
            id: randomUUID(),
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
      return rowFrom(row);
    },
    /** Saves a workspace's group; undefined when it has no such group. */
    async update(
      orgId: number,
      id: string,
      fields: GroupFields,
      by: { readonly login: string },
    ): Promise<ReleaseGroupRow | undefined> {
      const [row] = await claimingSlug(() =>
        db
          .update(releaseGroups)
          .set({
            ...fields,
            repositoryIds: [...fields.repositoryIds],
            updatedByLogin: by.login,
            updatedAt: now(),
          })
          .where(ofOrg(orgId, id))
          .returning(),
      );
      return row ? rowFrom(row) : undefined;
    },
    /** Deletes a workspace's group; undefined when it has no such group. */
    async remove(orgId: number, id: string): Promise<ReleaseGroupRow | undefined> {
      const [row] = await db.delete(releaseGroups).where(ofOrg(orgId, id)).returning();
      return row ? rowFrom(row) : undefined;
    },
  };
}
export type ReleaseGroupStore = ReturnType<typeof createReleaseGroupStore>;
