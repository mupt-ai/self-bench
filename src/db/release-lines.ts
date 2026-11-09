import { and, eq } from "drizzle-orm";
import { releases } from "./schema.js";

/**
 * The lines of releases: whose releases a row belongs to. A row sets exactly one of its line
 * columns (the `releases_line` check): a GitHub repository's id, a benchmark's, or a group's.
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
 * One workspace's releases of one of its public benchmarks (`benchmarks`): a Harbor registry
 * dataset such as Terminal-Bench. Its rows carry a repository's payload, marked `benchmark`, so
 * selfbench.dev shows it as a repository, under /evals.
 */
interface BenchmarkLine {
  readonly orgId: number;
  readonly benchmarkId: number;
}

/** A line of releases: a repository's, a public benchmark's, or a repository group's. */
export type AnyLine = ReleaseLine | BenchmarkLine | GroupLine;

/** A line's identity, for grouping rows by line. */
export const lineKey = (line: AnyLine) =>
  "groupId" in line
    ? `group/${line.groupId}`
    : "benchmarkId" in line
      ? `benchmark/${line.benchmarkId}`
      : `${line.orgId}/${line.githubRepoId}`;

/** A stored row's line, from whichever of its line columns is set. */
export const lineOfRow = (row: {
  orgId: number;
  githubRepoId: number | null;
  groupId: number | null;
  benchmarkId: number | null;
}): AnyLine =>
  row.groupId !== null
    ? { orgId: row.orgId, groupId: row.groupId }
    : row.benchmarkId !== null
      ? { orgId: row.orgId, benchmarkId: row.benchmarkId }
      : { orgId: row.orgId, githubRepoId: row.githubRepoId ?? 0 };

/** The rows of one line. */
export const ofLine = (line: AnyLine) =>
  "groupId" in line
    ? and(eq(releases.orgId, line.orgId), eq(releases.groupId, line.groupId))
    : "benchmarkId" in line
      ? and(eq(releases.orgId, line.orgId), eq(releases.benchmarkId, line.benchmarkId))
      : and(eq(releases.orgId, line.orgId), eq(releases.githubRepoId, line.githubRepoId));
