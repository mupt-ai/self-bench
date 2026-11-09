import { and, eq } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type { Database } from "../db/client.js";
import { credentialAuths } from "../db/credentials.js";
import { type AnyLine, currentOf, headOf, type ReleaseRow } from "../db/releases.js";
import { credentials, repos, repositoryGroups } from "../db/schema.js";
import { runnable, taskState } from "../db/task-record.js";
import { createTaskStore } from "../db/tasks.js";
import { evaluationTaskKey } from "../evaluation/models.js";
import { listRuns } from "../evaluation/run-list.js";
import type { EvaluationScope } from "../evaluation/scope.js";
import { evaluationPrefix, getEvaluation, live } from "../evaluation/store.js";
import type { EvaluationRun } from "../evaluation/types.js";
import { apiHeaders, GitHubOAuthError } from "../third_party/github/oauth.js";
import type { ReleaseInputs } from "./release-build.js";
import type { CredentialFacts } from "./release-results.js";
import type { ReleaseTask } from "./release-rule.js";
import type { TrialSource } from "./release-trials.js";
import type { ReleaseRepository } from "./release-types.js";

/**
 * Reads what a release is built from. Read-only, and wider than the app's stores on purpose:
 * deleted tasks and deleted credentials are included, because a release records every task's
 * state and old runs must still resolve the credential they used.
 */

/** Every task of a connected repository in any state, copying only what a release records. */
export async function releaseTasks(db: Database, repoId: number): Promise<ReleaseTask[]> {
  const all = await createTaskStore(db).listWithDeleted(repoId);
  return all.map((task) => ({
    key: evaluationTaskKey(task.runId, task.taskId),
    runId: task.runId,
    taskId: task.taskId,
    difficulty: task.difficulty,
    ...(task.sourcePr !== undefined ? { sourcePr: task.sourcePr } : {}),
    ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(task.review ? { review: task.review } : {}),
    // The compiled task its evaluations ran, so a release that publishes its tasks shows those.
    ...(task.bundleKey ? { bundleKey: task.bundleKey } : {}),
    state: task.deleted ? "deleted" : taskState(task),
    runnable: !task.deleted && runnable(task),
  }));
}

/** The sign-in type and endpoint of every model credential the workspace ever had. */
export async function releaseCredentials(
  db: Database,
  orgId: number,
): Promise<Map<string, CredentialFacts>> {
  const rows = await db
    .select({ id: credentials.id, auth: credentials.auth, endpoint: credentials.endpoint })
    .from(credentials)
    .where(eq(credentials.orgId, orgId));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        auth: credentialAuths.find((auth) => auth === row.auth) ?? "api-key",
        ...(row.endpoint ? { endpoint: row.endpoint } : {}),
      },
    ]),
  );
}

/** A row of a release line: a repository's (ReleaseRow) or a group's. */
type LineRow = Pick<ReleaseRow, "id" | "predecessorId" | "withdrawnAt" | "detail">;

/** Everything the release rule reads for one connected repository and its line's rows. */
export function releaseInputs(
  db: Database,
  artifacts: ArtifactStore,
  scope: { repoId: number; orgId: number },
  rows: readonly LineRow[],
): Promise<ReleaseInputs> {
  return lineInputs(
    db,
    artifacts,
    {
      scopes: [{ repoId: scope.repoId }],
      orgId: scope.orgId,
      tasks: releaseTasks(db, scope.repoId),
    },
    rows,
  );
}

/**
 * Everything the release rule reads for a line: `tasks` are what its runs may count (a
 * repository's, or every member's of a group), and its runs are the scope's.
 */
export async function lineInputs(
  db: Database,
  artifacts: ArtifactStore,
  source: {
    /** Whose runs count: the line's own scope, and for a group its members' too. */
    scopes: readonly EvaluationScope[];
    orgId: number;
    tasks: Promise<ReleaseTask[]>;
  },
  rows: readonly LineRow[],
): Promise<ReleaseInputs> {
  const [taskList, runs, credentialFacts] = await Promise.all([
    source.tasks,
    Promise.all(source.scopes.map((scope) => listRuns(artifacts, scope))).then((lists) =>
      lists.flatMap(({ runs = [] }) => runs.filter(live)),
    ),
    releaseCredentials(db, source.orgId),
  ]);
  const head = headOf(rows);
  const current = currentOf(rows);
  const keys = (row: LineRow, field: "tasks" | "settings" | "declined") => {
    const value = row.detail[field];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  };
  return {
    tasks: taskList,
    runs,
    credentials: credentialFacts,
    ...(current
      ? {
          previous: {
            tasks: keys(current, "tasks"),
            settings: keys(current, "settings"),
            declined: keys(current, "declined"),
          },
        }
      : {}),
    everReleased: new Set(rows.flatMap((row) => keys(row, "tasks"))),
    ...(head ? { headId: head.id } : {}),
    ...(current ? { currentId: current.id } : {}),
  };
}

/** How many runs' scopes `releasedTrials` remembers. */
const KEPT_SCOPES = 256;

/**
 * Reads released trials from the runs of the line, where its evaluations are kept: a connected
 * repository's, a public benchmark's, or a group's own and its members'. Nothing once the
 * repository (or a group's member) is disconnected or the run is gone, since a release outlives
 * both.
 */
export function releasedTrials(db: Database, artifacts: ArtifactStore): TrialSource {
  /** A connected repository's id by its GitHub id; each is looked up once, a miss asked again. */
  const repoIds = new Map<string, number>();
  const repoIdOf = async (orgId: number, githubId: number) => {
    const key = `${orgId}/${githubId}`;
    const known = repoIds.get(key);
    if (known !== undefined) return known;
    const [repo] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.orgId, orgId), eq(repos.githubId, githubId)));
    if (repo) repoIds.set(key, repo.id);
    return repo?.id;
  };
  /** Where a line's runs may be: a group's own, then each member's, as its release counted them. */
  const scopesOf = async (line: AnyLine): Promise<EvaluationScope[]> => {
    if ("benchmarkId" in line) return [{ benchmarkId: line.benchmarkId }];
    const githubIds =
      "groupId" in line
        ? ((
            await db
              .select({ ids: repositoryGroups.repositoryIds })
              .from(repositoryGroups)
              .where(eq(repositoryGroups.id, line.groupId))
          )[0]?.ids ?? [])
        : [line.githubRepoId];
    const members = await Promise.all(githubIds.map((id) => repoIdOf(line.orgId, id)));
    return [
      ...("groupId" in line ? [{ groupId: line.groupId }] : []),
      ...members.flatMap((repoId) => (repoId === undefined ? [] : [{ repoId }])),
    ];
  };
  /**
   * The scope each run read so far is kept under, by its id, so reading its artifacts after it
   * never reads the run again: a run holds every trial, so it is large.
   */
  const kept = new Map<string, EvaluationScope>();
  const located = async (line: AnyLine, evaluationId: string) => {
    for (const scope of await scopesOf(line)) {
      const run = await getEvaluation(artifacts, scope, evaluationId);
      if (!run) continue;
      kept.set(evaluationId, scope);
      for (const oldest of kept.keys()) {
        if (kept.size <= KEPT_SCOPES) break;
        kept.delete(oldest);
      }
      return { scope, run };
    }
    return undefined;
  };
  return {
    async run(line, evaluationId): Promise<EvaluationRun | undefined> {
      return (await located(line, evaluationId))?.run;
    },
    async artifact(line, evaluationId, name) {
      if (name.split("/").includes("..")) return undefined;
      const scope = kept.get(evaluationId) ?? (await located(line, evaluationId))?.scope;
      if (!scope) return undefined;
      const bytes = await artifacts.getByKey(
        `${evaluationPrefix(scope, evaluationId)}artifacts/${name}`,
      );
      return bytes ? Buffer.from(bytes).toString("utf8") : undefined;
    },
  };
}

/** A repository as GitHub reports it now, looked up by id so renames and transfers follow. */
export interface GitHubRepository extends ReleaseRepository {
  private: boolean;
  archived: boolean;
}

interface RepositoryResponse {
  id?: number;
  full_name?: string;
  private?: boolean;
  archived?: boolean;
  description?: string | null;
  language?: string | null;
  default_branch?: string;
  stargazers_count?: number;
  pushed_at?: string | null;
  owner?: { avatar_url?: string };
}

/** Undefined when GitHub has no such repository; any other failure throws. */
export async function lookupRepositoryById(
  githubApiUrl: string,
  token: string,
  id: number,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRepository | undefined> {
  const response = await fetchImpl(`${githubApiUrl}/repositories/${id}`, {
    headers: apiHeaders(token),
  });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new GitHubOAuthError(`GitHub repo lookup failed (${response.status})`, response.status);
  const row = (await response.json()) as RepositoryResponse;
  if (row.id !== id || !row.full_name) return undefined;
  return {
    id,
    fullName: row.full_name,
    private: row.private !== false,
    archived: row.archived === true,
    ...(row.description ? { description: row.description } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.default_branch ? { defaultBranch: row.default_branch } : {}),
    ...(typeof row.stargazers_count === "number" ? { stars: row.stargazers_count } : {}),
    ...(row.pushed_at ? { pushedAt: row.pushed_at } : {}),
    ...(row.owner?.avatar_url ? { ownerAvatarUrl: row.owner.avatar_url } : {}),
  };
}
