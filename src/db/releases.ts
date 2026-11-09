import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableColumns, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { GroupReleasePayload, PublishedGroup } from "../public/release-groups.js";
import type { ReleaseTask } from "../public/release-rule.js";
import { endpointHostsOf, type ReleasedResults } from "../public/release-trials.js";
import type { PublishedLine, PublishedRelease, ReleasePayload } from "../public/release-types.js";
import type { Database } from "./client.js";
import { chainOrder, currentOf } from "./release-chain.js";
import { type AnyLine, lineKey, lineOfRow, ofLine } from "./release-lines.js";
import { releases } from "./schema.js";

export { currentOf, headOf } from "./release-chain.js";
export type { AnyLine, ReleaseLine } from "./release-lines.js";

/** What a line's rows store in `payload`: a repository's or eval's release, or a group's. */
export type LinePayload = ReleasePayload | GroupReleasePayload;

/** A release row. What the public API serves is `published()`; the rest stays on the server. */
export interface ReleaseRow<Payload extends LinePayload = ReleasePayload> {
  readonly id: string;
  readonly line: AnyLine;
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
  readonly payload: Payload;
  /** How the release was built: tasks, trials, declined settings. Empty on public reads. */
  readonly detail: Record<string, unknown>;
}

export interface NewRelease {
  readonly line: AnyLine;
  readonly fullName: string;
  readonly publisherLogin: string;
  readonly predecessorId?: string;
  readonly releasedBy: { readonly id: number; readonly login: string };
  readonly hash: string;
  readonly payload: LinePayload;
  readonly detail: Record<string, unknown>;
}

/** Another release claimed the same head first. */
export class ReleaseConflict extends Error {}

/** A stored row, with or without its `detail`. */
type StoredRow = Omit<typeof releases.$inferSelect, "detail" | "releasedBy"> & {
  detail?: unknown;
};

const rowFrom = <Payload extends LinePayload = ReleasePayload>(
  row: StoredRow,
): ReleaseRow<Payload> => ({
  id: row.id,
  line: lineOfRow(row),
  fullName: row.fullName,
  publisherLogin: row.publisherLogin,
  ...(row.predecessorId ? { predecessorId: row.predecessorId } : {}),
  releasedByLogin: row.releasedByLogin,
  releasedAt: row.releasedAt.toISOString(),
  ...(row.withdrawnAt ? { withdrawnAt: row.withdrawnAt.toISOString() } : {}),
  ...(row.withdrawnByLogin ? { withdrawnByLogin: row.withdrawnByLogin } : {}),
  hash: row.hash,
  payload: row.payload as Payload,
  detail: (row.detail as Record<string, unknown> | undefined) ?? {},
});

/** A row as the public API serves it: the payload plus the row's id and time. */
const published = (row: ReleaseRow): PublishedRelease => ({
  ...row.payload,
  releaseId: row.id,
  releasedAt: row.releasedAt,
});
const publishedGroup = (row: ReleaseRow<GroupReleasePayload>): PublishedGroup => ({
  ...row.payload,
  releaseId: row.id,
  updatedAt: row.releasedAt,
});

const isUniqueViolation = (error: unknown): boolean => {
  const code = (error as { code?: unknown; cause?: { code?: unknown } }).code;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
};

/** Each line's current release among `rows`, which must hold whole lines. Newest first. */
function currentAmong<Row extends ReleaseRow<LinePayload>>(rows: readonly Row[]): Row[] {
  const byLine = new Map<string, Row[]>();
  for (const row of rows) {
    const key = lineKey(row.line);
    byLine.set(key, [...(byLine.get(key) ?? []), row]);
  }
  return [...byLine.values()]
    .flatMap((line) => currentOf(chainOrder(line)) ?? [])
    .sort((left, right) => right.releasedAt.localeCompare(left.releasedAt));
}

export function createReleaseStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  /** A GitHub repository's rows. */
  const repositoryRows = isNotNull(releases.githubRepoId);
  const newestFirst = [desc(releases.releasedAt), desc(releases.id)];
  const rowsWhere = async (where?: SQL) =>
    (
      await db
        .select()
        .from(releases)
        .where(where)
        .orderBy(...newestFirst)
    ).map((row) => rowFrom<LinePayload>(row));
  // `detail` is the bulk of a row and never public, so public reads leave it out.
  const { detail: _detail, releasedBy: _releasedBy, ...publicColumns } = getTableColumns(releases);
  const publicRowsWhere = async (where?: SQL) =>
    (
      await db
        .select(publicColumns)
        .from(releases)
        .where(where)
        .orderBy(...newestFirst)
    ).map((row) => rowFrom<LinePayload>(row));
  const asLines = (rows: readonly ReleaseRow<LinePayload>[]): PublishedLine[] =>
    rows.map((row) => ({ release: published(row as ReleaseRow), endorsed: false }));
  return {
    /** Every row of the line, newest first, withdrawn ones included. */
    async list<Payload extends LinePayload = ReleasePayload>(
      line: AnyLine,
    ): Promise<ReleaseRow<Payload>[]> {
      return chainOrder((await rowsWhere(ofLine(line))) as ReleaseRow<Payload>[]);
    },
    /**
     * Inserts a release that names the head it was built on. Two releases naming the same
     * head, or two first releases of a line, cannot both succeed.
     */
    async insert<Payload extends LinePayload = ReleasePayload>(
      release: NewRelease,
    ): Promise<ReleaseRow<Payload>> {
      try {
        const [row] = await db
          .insert(releases)
          .values({
            id: randomUUID(),
            orgId: release.line.orgId,
            ...("groupId" in release.line
              ? { groupId: release.line.groupId }
              : "benchmarkId" in release.line
                ? { benchmarkId: release.line.benchmarkId }
                : { githubRepoId: release.line.githubRepoId }),
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
        return rowFrom<Payload>(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ReleaseConflict("Someone else released first");
        throw error;
      }
    },
    /** Hides a release from the public; the line falls back to its previous release. */
    async withdraw<Payload extends LinePayload = ReleasePayload>(
      line: AnyLine,
      id: string,
      login: string,
    ): Promise<ReleaseRow<Payload> | undefined> {
      const [row] = await db
        .update(releases)
        .set({ withdrawnAt: now(), withdrawnByLogin: login })
        .where(and(ofLine(line), eq(releases.id, id), isNull(releases.withdrawnAt)))
        .returning();
      return row ? rowFrom<Payload>(row) : undefined;
    },
    /** Withdraws every public release of a line: what deleting a group does. */
    async withdrawLine(line: AnyLine, login: string): Promise<number> {
      const rows = await db
        .update(releases)
        .set({ withdrawnAt: now(), withdrawnByLogin: login })
        .where(and(ofLine(line), isNull(releases.withdrawnAt)))
        .returning({ id: releases.id });
      return rows.length;
    },
    /**
     * The tasks a release was built on, as its row records them (`detail.releasedTasks`), in key
     * order; undefined when there is no such row. Reads that one field, not the whole detail.
     * Private: callers serve only what a release that published its tasks allows.
     */
    async releasedTasks(id: string): Promise<ReleaseTask[] | undefined> {
      const [row] = await db
        .select({ tasks: sql<unknown>`${releases.detail} -> 'releasedTasks'` })
        .from(releases)
        .where(eq(releases.id, id));
      if (!row) return undefined;
      return Array.isArray(row.tasks) ? (row.tasks as ReleaseTask[]) : [];
    },
    /**
     * Each setting's result on each task of a release (`detail.results`), with the line, whose
     * repository holds the trials; undefined when there is no such row. Private: callers serve
     * only what a release that published its trials allows.
     */
    async releasedResults(id: string): Promise<ReleasedResults | undefined> {
      const [row] = await db
        .select({
          orgId: releases.orgId,
          githubRepoId: releases.githubRepoId,
          results: sql<unknown>`${releases.detail} -> 'results'`,
          settingsDetail: sql<unknown>`${releases.detail} -> 'settingsDetail'`,
        })
        .from(releases)
        .where(eq(releases.id, id));
      // A group's release publishes no trials.
      if (!row || row.githubRepoId === null) return undefined;
      return {
        line: { orgId: row.orgId, githubRepoId: row.githubRepoId },
        results:
          row.results && typeof row.results === "object"
            ? (row.results as ReleasedResults["results"])
            : {},
        endpointHosts: endpointHostsOf(row.settingsDetail),
      };
    },
    /**
     * Every repository's and public benchmark's line's current release, newest first: both carry
     * a repository's payload, a benchmark's marked `benchmark`.
     */
    async currentLines(): Promise<PublishedLine[]> {
      return asLines(currentAmong(await publicRowsWhere(isNull(releases.groupId))));
    },
    /** Every repository group's current release, newest first. */
    async currentGroups(): Promise<PublishedGroup[]> {
      const rows = (await publicRowsWhere(
        sql`${releases.groupId} is not null`,
      )) as ReleaseRow<GroupReleasePayload>[];
      return currentAmong(rows).map(publishedGroup);
    },
    /** The current release of each line whose latest release names `fullName`, newest first. */
    async currentLinesFor(fullName: string): Promise<PublishedLine[]> {
      const wanted = fullName.toLowerCase();
      // A renamed repository's line is found under any name it released with, then shown
      // only under the name its current release carries.
      const named = await db
        .selectDistinct({ orgId: releases.orgId, githubRepoId: releases.githubRepoId })
        .from(releases)
        .where(and(eq(sql`lower(${releases.fullName})`, wanted), repositoryRows));
      if (named.length === 0) return [];
      const lines = named.map(({ orgId, githubRepoId }) => ({
        orgId,
        githubRepoId: githubRepoId ?? 0,
      }));
      const current = currentAmong(await publicRowsWhere(or(...lines.map(ofLine))));
      return asLines(current.filter((row) => row.fullName.toLowerCase() === wanted));
    },
  };
}
export type ReleaseStore = ReturnType<typeof createReleaseStore>;
