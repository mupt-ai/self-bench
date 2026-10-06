import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableColumns, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { ReleaseTask } from "../public/release-rule.js";
import type { GroupReleasePayload, PublishedGroupRelease } from "../public/release-types.js";
import type { Database } from "./client.js";
import { chainOrder, currentAmong, isUniqueViolation, ReleaseConflict } from "./releases.js";
import { groupReleases } from "./schema.js";

/** One workspace's releases of one of its groups. */
export interface GroupReleaseLine {
  readonly orgId: number;
  readonly groupId: string;
}

/** A group release row. What the public API serves is the payload; the rest stays here. */
export interface GroupReleaseRow {
  readonly id: string;
  readonly line: GroupReleaseLine;
  readonly slug: string;
  readonly name: string;
  readonly publisherLogin: string;
  readonly predecessorId?: string;
  readonly releasedByLogin: string;
  readonly releasedAt: string;
  readonly withdrawnAt?: string;
  readonly withdrawnByLogin?: string;
  readonly hash: string;
  readonly payload: GroupReleasePayload;
  readonly detail: Record<string, unknown>;
}

export interface NewGroupRelease {
  readonly line: GroupReleaseLine;
  readonly slug: string;
  readonly name: string;
  readonly publisherLogin: string;
  readonly predecessorId?: string;
  readonly releasedBy: { readonly id: number; readonly login: string };
  readonly hash: string;
  readonly payload: GroupReleasePayload;
  readonly detail: Record<string, unknown>;
}

/** Another line released under this slug first. */
export class SlugTaken extends Error {}

type StoredRow = Omit<typeof groupReleases.$inferSelect, "detail" | "releasedBy"> & {
  detail?: unknown;
};

const rowFrom = (row: StoredRow): GroupReleaseRow => ({
  id: row.id,
  line: { orgId: row.orgId, groupId: row.groupId },
  slug: row.slug,
  name: row.name,
  publisherLogin: row.publisherLogin,
  ...(row.predecessorId ? { predecessorId: row.predecessorId } : {}),
  releasedByLogin: row.releasedByLogin,
  releasedAt: row.releasedAt.toISOString(),
  ...(row.withdrawnAt ? { withdrawnAt: row.withdrawnAt.toISOString() } : {}),
  ...(row.withdrawnByLogin ? { withdrawnByLogin: row.withdrawnByLogin } : {}),
  hash: row.hash,
  payload: row.payload as GroupReleasePayload,
  detail: (row.detail as Record<string, unknown> | undefined) ?? {},
});

const groupLine = (row: GroupReleaseRow) => `${row.line.orgId}/${row.line.groupId}`;

export function createGroupReleaseStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const ofLine = (line: GroupReleaseLine) =>
    and(eq(groupReleases.orgId, line.orgId), eq(groupReleases.groupId, line.groupId));
  // `detail` is the bulk of a row and never public, so public reads leave it out.
  const {
    detail: _detail,
    releasedBy: _releasedBy,
    ...publicColumns
  } = getTableColumns(groupReleases);
  const rowsWhere = async (where: SQL | undefined, columns = false) =>
    (
      await (columns ? db.select(publicColumns) : db.select())
        .from(groupReleases)
        .where(where)
        .orderBy(desc(groupReleases.releasedAt), desc(groupReleases.id))
    ).map(rowFrom);
  /** Whether a line other than `line` claimed `slug`, withdrawn or not: addresses never move. */
  const slugTaken = async (slug: string, line: GroupReleaseLine): Promise<boolean> => {
    const [row] = await db
      .select({ id: groupReleases.id })
      .from(groupReleases)
      .where(
        and(
          eq(sql`lower(${groupReleases.slug})`, slug.toLowerCase()),
          isNull(groupReleases.predecessorId),
          or(ne(groupReleases.orgId, line.orgId), ne(groupReleases.groupId, line.groupId)),
        ),
      );
    return row !== undefined;
  };
  return {
    slugTaken,
    /** Every row of the line, newest first, withdrawn ones included. */
    async list(line: GroupReleaseLine): Promise<GroupReleaseRow[]> {
      return chainOrder(await rowsWhere(ofLine(line)));
    },
    /**
     * Inserts a release that names the head it was built on. Two releases naming the same head,
     * or two first releases of a line, cannot both succeed; nor two lines one slug.
     */
    async insert(release: NewGroupRelease): Promise<GroupReleaseRow> {
      try {
        const [row] = await db
          .insert(groupReleases)
          .values({
            id: randomUUID(),
            orgId: release.line.orgId,
            groupId: release.line.groupId,
            slug: release.slug,
            name: release.name,
            publisherLogin: release.publisherLogin,
            predecessorId: release.predecessorId ?? null,
            releasedBy: release.releasedBy.id,
            releasedByLogin: release.releasedBy.login,
            releasedAt: now(),
            hash: release.hash,
            payload: release.payload,
            detail: release.detail,
          })
          .returning();
        if (!row) throw new Error("group release insert returned no row");
        return rowFrom(row);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (!release.predecessorId && (await slugTaken(release.slug, release.line)))
          throw new SlugTaken("This address is taken");
        throw new ReleaseConflict("Someone else released first");
      }
    },
    /** Hides a release from the public; the line falls back to its previous release. */
    async withdraw(
      line: GroupReleaseLine,
      id: string,
      login: string,
    ): Promise<GroupReleaseRow | undefined> {
      const [row] = await db
        .update(groupReleases)
        .set({ withdrawnAt: now(), withdrawnByLogin: login })
        .where(and(ofLine(line), eq(groupReleases.id, id), isNull(groupReleases.withdrawnAt)))
        .returning();
      return row ? rowFrom(row) : undefined;
    },
    /** The tasks a release was built on, as its row records them; undefined for no such row. */
    async releasedTasks(id: string): Promise<ReleaseTask[] | undefined> {
      const [row] = await db
        .select({ tasks: sql<unknown>`${groupReleases.detail} -> 'releasedTasks'` })
        .from(groupReleases)
        .where(eq(groupReleases.id, id));
      if (!row) return undefined;
      return Array.isArray(row.tasks) ? (row.tasks as ReleaseTask[]) : [];
    },
    /** Every line's current release, newest first. */
    async currentLines(): Promise<PublishedGroupRelease[]> {
      return currentAmong(await rowsWhere(undefined, true), groupLine).map((row) => ({
        ...row.payload,
        releaseId: row.id,
        releasedAt: row.releasedAt,
      }));
    },
  };
}
export type GroupReleaseStore = ReturnType<typeof createGroupReleaseStore>;
