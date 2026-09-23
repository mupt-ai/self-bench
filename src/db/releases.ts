import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableColumns, isNull, or, type SQL, sql } from "drizzle-orm";
import type { PublishedLine, PublishedRelease, ReleasePayload } from "../public/release-types.js";
import type { Database } from "./client.js";
import { releases } from "./schema.js";

/** One workspace's releases of one GitHub repository. */
export interface ReleaseLine {
  readonly orgId: number;
  readonly githubRepoId: number;
}

/** A release row. What the public API serves is `published()`; the rest stays on the server. */
export interface ReleaseRow {
  readonly id: string;
  readonly line: ReleaseLine;
  readonly fullName: string;
  readonly publisherLogin: string;
  /** The head this row was written after; absent for a line's first release. */
  readonly predecessorId?: string;
  readonly releasedByLogin: string;
  readonly releasedAt: string;
  readonly withdrawnAt?: string;
  readonly withdrawnByLogin?: string;
  /** SHA-256 of the payload, the trials behind it, and declined settings; unchanged writes no row. */
  readonly hash: string;
  /** What selfbench.dev shows. */
  readonly payload: ReleasePayload;
  /** How the release was built: tasks, trials, declined settings. Empty on public reads. */
  readonly detail: Record<string, unknown>;
}

export interface NewRelease {
  readonly line: ReleaseLine;
  readonly fullName: string;
  readonly publisherLogin: string;
  readonly predecessorId?: string;
  readonly releasedBy: { readonly id: number; readonly login: string };
  readonly hash: string;
  readonly payload: ReleasePayload;
  readonly detail: Record<string, unknown>;
}

/** Another release claimed the same head first. */
export class ReleaseConflict extends Error {}

/** A stored row, with or without its `detail`. */
type StoredRow = Omit<typeof releases.$inferSelect, "detail" | "releasedBy"> & {
  detail?: unknown;
};

const rowFrom = (row: StoredRow): ReleaseRow => ({
  id: row.id,
  line: { orgId: row.orgId, githubRepoId: row.githubRepoId },
  fullName: row.fullName,
  publisherLogin: row.publisherLogin,
  ...(row.predecessorId ? { predecessorId: row.predecessorId } : {}),
  releasedByLogin: row.releasedByLogin,
  releasedAt: row.releasedAt.toISOString(),
  ...(row.withdrawnAt ? { withdrawnAt: row.withdrawnAt.toISOString() } : {}),
  ...(row.withdrawnByLogin ? { withdrawnByLogin: row.withdrawnByLogin } : {}),
  hash: row.hash,
  payload: row.payload as ReleasePayload,
  detail: (row.detail as Record<string, unknown> | undefined) ?? {},
});

/** A row as the public API serves it: the payload plus the row's id and time. */
const published = (row: ReleaseRow): PublishedRelease => ({
  ...row.payload,
  releaseId: row.id,
  releasedAt: row.releasedAt,
});

const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: unknown; cause?: { code?: unknown } }).code;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
};

/**
 * A line's rows along the predecessor chain, newest first. Each row names the head it was
 * written after, so the chain, not the clock, decides which row is newest.
 */
function chainOrder(rows: readonly ReleaseRow[]): ReleaseRow[] {
  const next = new Map(rows.map((row) => [row.predecessorId ?? "", row]));
  const chain: ReleaseRow[] = [];
  for (let row = next.get(""); row && chain.length < rows.length; row = next.get(row.id))
    chain.push(row);
  // The unique constraint keeps every row on the chain; any stray row is kept rather than lost.
  const onChain = new Set(chain.map((row) => row.id));
  return [...chain.reverse(), ...rows.filter((row) => !onChain.has(row.id))];
}

/** The line's newest row, withdrawn or not. A release names the head it was built on. */
export const headOf = (rows: readonly ReleaseRow[]): ReleaseRow | undefined => rows[0];
/** The line's newest row not withdrawn: what the public sees. */
export const currentOf = (rows: readonly ReleaseRow[]): ReleaseRow | undefined =>
  rows.find((row) => !row.withdrawnAt);

/** Each line's current release among `rows`, which must hold whole lines. Newest first. */
function currentAmong(rows: readonly ReleaseRow[]): ReleaseRow[] {
  const byLine = new Map<string, ReleaseRow[]>();
  for (const row of rows) {
    const key = `${row.line.orgId}/${row.line.githubRepoId}`;
    byLine.set(key, [...(byLine.get(key) ?? []), row]);
  }
  return [...byLine.values()]
    .flatMap((line) => currentOf(chainOrder(line)) ?? [])
    .sort((left, right) => right.releasedAt.localeCompare(left.releasedAt));
}

export function createReleaseStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const ofLine = (line: ReleaseLine) =>
    and(eq(releases.orgId, line.orgId), eq(releases.githubRepoId, line.githubRepoId));
  const newestFirst = [desc(releases.releasedAt), desc(releases.id)];
  const rowsWhere = async (where?: SQL) =>
    (
      await db
        .select()
        .from(releases)
        .where(where)
        .orderBy(...newestFirst)
    ).map(rowFrom);
  // `detail` is the bulk of a row and never public, so public reads leave it out.
  const { detail: _detail, releasedBy: _releasedBy, ...publicColumns } = getTableColumns(releases);
  const publicRowsWhere = async (where?: SQL) =>
    (
      await db
        .select(publicColumns)
        .from(releases)
        .where(where)
        .orderBy(...newestFirst)
    ).map(rowFrom);
  const asLines = (rows: readonly ReleaseRow[]): PublishedLine[] =>
    rows.map((row) => ({ release: published(row), endorsed: false }));
  return {
    /** Every row of the line, newest first, withdrawn ones included. */
    async list(line: ReleaseLine): Promise<ReleaseRow[]> {
      return chainOrder(await rowsWhere(ofLine(line)));
    },
    /**
     * Inserts a release that names the head it was built on. Two releases naming the same
     * head, or two first releases of a line, cannot both succeed.
     */
    async insert(release: NewRelease): Promise<ReleaseRow> {
      try {
        const [row] = await db
          .insert(releases)
          .values({
            id: randomUUID(),
            orgId: release.line.orgId,
            githubRepoId: release.line.githubRepoId,
            fullName: release.fullName,
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
        if (!row) throw new Error("release insert returned no row");
        return rowFrom(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ReleaseConflict("Someone else released first");
        throw error;
      }
    },
    /** Hides a release from the public; the line falls back to its previous release. */
    async withdraw(line: ReleaseLine, id: string, login: string): Promise<ReleaseRow | undefined> {
      const [row] = await db
        .update(releases)
        .set({ withdrawnAt: now(), withdrawnByLogin: login })
        .where(and(ofLine(line), eq(releases.id, id), isNull(releases.withdrawnAt)))
        .returning();
      return row ? rowFrom(row) : undefined;
    },
    /** Every line's current release, newest first. */
    async currentLines(): Promise<PublishedLine[]> {
      return asLines(currentAmong(await publicRowsWhere()));
    },
    /** The current release of each line whose latest release names `fullName`, newest first. */
    async currentLinesFor(fullName: string): Promise<PublishedLine[]> {
      const wanted = fullName.toLowerCase();
      // A renamed repository's line is found under any name it released with, then shown
      // only under the name its current release carries.
      const named = await db
        .selectDistinct({ orgId: releases.orgId, githubRepoId: releases.githubRepoId })
        .from(releases)
        .where(eq(sql`lower(${releases.fullName})`, wanted));
      if (named.length === 0) return [];
      const current = currentAmong(await publicRowsWhere(or(...named.map(ofLine))));
      return asLines(current.filter((row) => row.fullName.toLowerCase() === wanted));
    },
  };
}
export type ReleaseStore = ReturnType<typeof createReleaseStore>;
