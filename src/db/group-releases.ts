import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableColumns, isNull, type SQL } from "drizzle-orm";
import type { GroupReleasePayload, PublishedGroup } from "../public/release-groups.js";
import type { Database } from "./client.js";
import { chainOrder, currentOf, ReleaseConflict } from "./releases.js";
import { groupReleases } from "./schema.js";

/** A group release row. What the public API serves is `published()`; the rest stays here. */
export interface GroupReleaseRow {
  readonly id: string;
  readonly groupId: number;
  readonly orgId: number;
  readonly slug: string;
  readonly publisherLogin: string;
  readonly predecessorId?: string;
  readonly releasedByLogin: string;
  readonly releasedAt: string;
  readonly withdrawnAt?: string;
  readonly withdrawnByLogin?: string;
  readonly hash: string;
  readonly payload: GroupReleasePayload;
  /** How it was built: tasks, trials, declined settings. Empty on public reads. */
  readonly detail: Record<string, unknown>;
}

export interface NewGroupRelease {
  readonly groupId: number;
  readonly orgId: number;
  readonly slug: string;
  readonly publisherLogin: string;
  readonly predecessorId?: string;
  readonly releasedBy: { readonly id: number; readonly login: string };
  readonly hash: string;
  readonly payload: GroupReleasePayload;
  readonly detail: Record<string, unknown>;
}

type StoredRow = Omit<typeof groupReleases.$inferSelect, "detail" | "releasedBy"> & {
  detail?: unknown;
};

const rowFrom = (row: StoredRow): GroupReleaseRow => ({
  id: row.id,
  groupId: row.groupId,
  orgId: row.orgId,
  slug: row.slug,
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

/** A row as the public API serves it: the payload plus its id and time. */
const published = (row: GroupReleaseRow): PublishedGroup => ({
  ...row.payload,
  releaseId: row.id,
  updatedAt: row.releasedAt,
});

const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
};

/** Group releases: append-only lines like a repository's (releases.ts), one per group. */
export function createGroupReleaseStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const newestFirst = [desc(groupReleases.releasedAt), desc(groupReleases.id)];
  const ofGroup = (groupId: number) => eq(groupReleases.groupId, groupId);
  const rowsWhere = async (where?: SQL) =>
    (
      await db
        .select()
        .from(groupReleases)
        .where(where)
        .orderBy(...newestFirst)
    ).map(rowFrom);
  // `detail` is the bulk of a row and never public, so public reads leave it out.
  const { detail: _detail, releasedBy: _by, ...publicColumns } = getTableColumns(groupReleases);
  return {
    /** Every row of the group's line, newest first, withdrawn ones included. */
    async list(groupId: number): Promise<GroupReleaseRow[]> {
      return chainOrder(await rowsWhere(ofGroup(groupId)));
    },
    /** Inserts a release naming the head it was built on; two on one head cannot both win. */
    async insert(release: NewGroupRelease): Promise<GroupReleaseRow> {
      try {
        const [row] = await db
          .insert(groupReleases)
          .values({
            id: randomUUID(),
            groupId: release.groupId,
            orgId: release.orgId,
            slug: release.slug,
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
        if (isUniqueViolation(error)) throw new ReleaseConflict("Someone else released first");
        throw error;
      }
    },
    /** Hides a release from the public; the group falls back to its previous release. */
    async withdraw(
      groupId: number,
      id: string,
      login: string,
    ): Promise<GroupReleaseRow | undefined> {
      const [row] = await db
        .update(groupReleases)
        .set({ withdrawnAt: now(), withdrawnByLogin: login })
        .where(and(ofGroup(groupId), eq(groupReleases.id, id), isNull(groupReleases.withdrawnAt)))
        .returning();
      return row ? rowFrom(row) : undefined;
    },
    /** Every group's current release, newest first. */
    async currentGroups(): Promise<PublishedGroup[]> {
      const rows = (
        await db
          .select(publicColumns)
          .from(groupReleases)
          .orderBy(...newestFirst)
      ).map(rowFrom);
      const byGroup = new Map<number, GroupReleaseRow[]>();
      for (const row of rows) byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row]);
      return [...byGroup.values()]
        .flatMap((line) => currentOf(chainOrder(line)) ?? [])
        .sort((left, right) => right.releasedAt.localeCompare(left.releasedAt))
        .map(published);
    },
  };
}
export type GroupReleaseStore = ReturnType<typeof createGroupReleaseStore>;
