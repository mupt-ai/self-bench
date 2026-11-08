import { and, eq, isNull } from "drizzle-orm";
import { releases } from "./schema.js";

/**
 * The lines of releases: whose releases a row belongs to. A row sets exactly one of its line
 * columns (the `releases_line` check): a GitHub repository's id, an eval's, or a group's.
 */

/** One workspace's releases of one GitHub repository. */
export interface ReleaseLine {
  readonly orgId: number;
  readonly githubRepoId: number;
}

/** One workspace's releases of one of its repository groups. */
interface GroupLine {
  readonly orgId: number;
  readonly groupId: number;
}

/**
 * One workspace's releases of one of its evals, by the eval's `repos` id (it has no GitHub id).
 * Its rows carry a repository's payload, so selfbench.dev lists and shows it as one.
 */
export interface EvalLine {
  readonly orgId: number;
  readonly evalRepoId: number;
}

/** A line of releases: a repository's, an eval's, or a repository group's. */
export type AnyLine = ReleaseLine | EvalLine | GroupLine;

/** A line's identity, for grouping rows by line. */
export const lineKey = (line: AnyLine) =>
  "groupId" in line
    ? `group/${line.groupId}`
    : "evalRepoId" in line
      ? `eval/${line.evalRepoId}`
      : `${line.orgId}/${line.githubRepoId}`;

/** A stored row's line, from whichever of its line columns is set. */
export const lineOfRow = (row: {
  orgId: number;
  githubRepoId: number | null;
  groupId: number | null;
  evalRepoId: number | null;
}): AnyLine =>
  row.groupId !== null
    ? { orgId: row.orgId, groupId: row.groupId }
    : row.evalRepoId !== null
      ? { orgId: row.orgId, evalRepoId: row.evalRepoId }
      : { orgId: row.orgId, githubRepoId: row.githubRepoId ?? 0 };

/** The rows of one line. */
export const ofLine = (line: AnyLine) =>
  "groupId" in line
    ? and(eq(releases.orgId, line.orgId), eq(releases.groupId, line.groupId))
    : "evalRepoId" in line
      ? and(eq(releases.orgId, line.orgId), eq(releases.evalRepoId, line.evalRepoId))
      : and(
          eq(releases.orgId, line.orgId),
          eq(releases.githubRepoId, line.githubRepoId),
          isNull(releases.groupId),
        );
