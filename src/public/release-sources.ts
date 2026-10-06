import { eq } from "drizzle-orm";
import type { ArtifactStore } from "../artifacts/index.js";
import type { Database } from "../db/client.js";
import { credentialAuths } from "../db/credentials.js";
import { currentOf, headOf, type ReleaseRow } from "../db/releases.js";
import { credentials } from "../db/schema.js";
import { runnable, taskState } from "../db/task-record.js";
import { createTaskStore } from "../db/tasks.js";
import { evaluationTaskKey } from "../evaluation/models.js";
import { listEvaluations } from "../evaluation/store.js";
import { apiHeaders, GitHubOAuthError } from "../third_party/github/oauth.js";
import type { ReleaseInputs } from "./release-build.js";
import type { CredentialFacts } from "./release-results.js";
import type { ReleaseTask } from "./release-rule.js";
import type { ReleaseRepository } from "./release-types.js";

/**
 * Reads what a release is built from. Read-only, and wider than the app's stores on purpose:
 * deleted tasks and deleted credentials are included, because a release records every task's
 * state and old runs must still resolve the credential they used.
 */

/** Every task of a connected repository in any state, copying only what a release records. */
async function releaseTasks(db: Database, repoId: number): Promise<ReleaseTask[]> {
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

/** What a line's rows tell the rule: its current release, every task it ever released, its head. */
export function lineState(
  rows: readonly {
    readonly id: string;
    readonly releasedAt: string;
    readonly withdrawnAt?: string;
    readonly detail: Record<string, unknown>;
  }[],
): Pick<ReleaseInputs, "previous" | "everReleased" | "headId" | "currentId"> {
  const head = headOf(rows);
  const current = currentOf(rows);
  const keys = (row: (typeof rows)[number], field: "tasks" | "settings" | "declined") => {
    const value = row.detail[field];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  };
  return {
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

/** Everything the release rule reads for one connected repository and its line's rows. */
export async function releaseInputs(
  db: Database,
  artifacts: ArtifactStore,
  scope: { repoId: number; orgId: number },
  rows: readonly ReleaseRow[],
): Promise<ReleaseInputs> {
  const [taskList, runs, credentialFacts] = await Promise.all([
    releaseTasks(db, scope.repoId),
    listEvaluations(artifacts, scope.repoId),
    releaseCredentials(db, scope.orgId),
  ]);
  return { tasks: taskList, runs, credentials: credentialFacts, ...lineState(rows) };
}

/**
 * What the rule reads for a group: every member's tasks and runs as one repository's, which
 * their keys (each task's generation batch and id) keep apart. `memberOf` names each task's
 * member by the key the caller gave it.
 */
export async function groupReleaseInputs<Key>(
  db: Database,
  artifacts: ArtifactStore,
  scope: { orgId: number; members: readonly { repoId: number; key: Key }[] },
  rows: Parameters<typeof lineState>[0],
): Promise<{ inputs: ReleaseInputs; memberOf: Map<string, Key> }> {
  const [members, credentialFacts] = await Promise.all([
    Promise.all(
      scope.members.map(async (member) => {
        const [tasks, runs] = await Promise.all([
          releaseTasks(db, member.repoId),
          listEvaluations(artifacts, member.repoId),
        ]);
        return { key: member.key, tasks, runs };
      }),
    ),
    releaseCredentials(db, scope.orgId),
  ]);
  return {
    inputs: {
      tasks: members.flatMap((member) => member.tasks),
      runs: members.flatMap((member) => member.runs),
      credentials: credentialFacts,
      ...lineState(rows),
    },
    memberOf: new Map(
      members.flatMap((member) => member.tasks.map((task) => [task.key, member.key] as const)),
    ),
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

/**
 * Each repository as GitHub reports it now, when every one is public; otherwise why not, as a
 * status and message for the releaser.
 */
export async function publicRepositories(
  githubApiUrl: string,
  token: string,
  repositories: readonly { githubId: number; fullName: string }[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ repositories: GitHubRepository[] } | { status: 400 | 503; error: string }> {
  let found: (GitHubRepository | undefined)[];
  try {
    found = await Promise.all(
      repositories.map((repo) =>
        lookupRepositoryById(githubApiUrl, token, repo.githubId, fetchImpl),
      ),
    );
  } catch (error) {
    if (!(error instanceof GitHubOAuthError)) throw error;
    return {
      status: 503,
      error: "GitHub could not confirm that the repositories are public. Try again in a moment.",
    };
  }
  const closed = repositories.filter((_, index) => !found[index] || found[index]?.private);
  if (closed.length > 0)
    return {
      status: 400,
      error: `Only public repositories can be released. Not public: ${closed.map((repo) => repo.fullName).join(", ")}.`,
    };
  return { repositories: found.filter((repo) => repo !== undefined) };
}
