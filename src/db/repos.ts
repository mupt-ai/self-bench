import { and, desc, eq, sql } from "drizzle-orm";
import { EVAL_OWNER } from "../contracts/evals.js";
import type { Database } from "./client.js";
import { repos, users } from "./schema.js";

/**
 * A repository connected to a tenant, or an eval (kind "eval"): an org's own collection of
 * workspace scenarios, with no GitHub repository and so no GitHub id (contracts/evals.ts).
 */
export interface ConnectedRepo {
  readonly id: number;
  readonly orgId: number;
  readonly kind: "github" | "eval";
  /** Null for an eval. */
  readonly githubId: number | null;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  /** Keep building tasks as pull requests merge; off means on demand only. */
  readonly continuous: boolean;
  /** How long a solver's agent may work on each task (trialTimeouts). */
  readonly agentMinutes: number;
  readonly connectedBy: { readonly id: number; readonly login: string };
  readonly connectedAt: string;
}

/** A connected GitHub repository, which has a GitHub id. */
export type GitHubRepo = ConnectedRepo & { readonly kind: "github"; readonly githubId: number };

export function isGitHubRepo(repo: ConnectedRepo): repo is GitHubRepo {
  return repo.kind === "github" && repo.githubId !== null;
}

interface ConnectRepoInput {
  readonly orgId: number;
  readonly githubId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly connectedBy: number;
}

export interface RepoStore {
  /** Connected repos for one tenant, most recently connected first. */
  list(orgId: number): Promise<ConnectedRepo[]>;
  find(orgId: number, fullName: string): Promise<ConnectedRepo | undefined>;
  /** Connects a repo, or refreshes the existing row when the GitHub id is already connected. */
  connect(input: ConnectRepoInput): Promise<ConnectedRepo>;
  /** Creates an eval named `evals/<slug>`; undefined when the org already has one by that name. */
  createEval(input: {
    readonly orgId: number;
    readonly slug: string;
    readonly createdBy: number;
  }): Promise<ConnectedRepo | undefined>;
  /** True when a row was removed. */
  disconnect(orgId: number, fullName: string): Promise<boolean>;
  /** Undefined when the repo is not connected to this tenant. */
  update(
    orgId: number,
    fullName: string,
    settings: { continuous?: boolean | undefined; agentMinutes?: number | undefined },
  ): Promise<ConnectedRepo | undefined>;
}

export function createRepoStore(db: Database, options: { now?: () => Date } = {}): RepoStore {
  const now = options.now ?? (() => new Date());
  const select = () =>
    db
      .select({ repo: repos, login: users.login })
      .from(repos)
      .innerJoin(users, eq(users.id, repos.connectedBy));
  const byName = (orgId: number, fullName: string) =>
    and(eq(repos.orgId, orgId), eq(sql`lower(${repos.fullName})`, fullName.toLowerCase()));
  const one = async (id: number): Promise<ConnectedRepo> => {
    const [row] = await select().where(eq(repos.id, id));
    if (!row) throw new Error(`repo ${id} vanished`);
    return repoFrom(row);
  };
  return {
    async list(orgId) {
      const rows = await select()
        .where(eq(repos.orgId, orgId))
        .orderBy(desc(repos.connectedAt), desc(repos.id));
      return rows.map(repoFrom);
    },
    async find(orgId, fullName) {
      const [row] = await select().where(byName(orgId, fullName));
      return row ? repoFrom(row) : undefined;
    },
    async connect(input) {
      const [row] = await db
        .insert(repos)
        .values({ ...input, connectedAt: now() })
        .onConflictDoUpdate({
          target: [repos.orgId, repos.githubId],
          set: {
            fullName: input.fullName,
            defaultBranch: input.defaultBranch,
            private: input.private,
          },
        })
        .returning({ id: repos.id });
      if (!row) throw new Error("repo connect returned no row");
      return one(row.id);
    },
    async createEval(input) {
      const [row] = await db
        .insert(repos)
        .values({
          orgId: input.orgId,
          kind: "eval",
          githubId: null,
          fullName: `${EVAL_OWNER}/${input.slug}`,
          defaultBranch: "",
          // An eval is never released to selbench.dev, which shows only public repositories.
          private: true,
          connectedBy: input.createdBy,
          connectedAt: now(),
        })
        .onConflictDoNothing()
        .returning({ id: repos.id });
      return row ? one(row.id) : undefined;
    },
    async disconnect(orgId, fullName) {
      const rows = await db
        .delete(repos)
        .where(byName(orgId, fullName))
        .returning({ id: repos.id });
      return rows.length > 0;
    },
    async update(orgId, fullName, settings) {
      const [row] = await db
        .update(repos)
        .set(settings)
        .where(byName(orgId, fullName))
        .returning({ id: repos.id });
      return row ? one(row.id) : undefined;
    },
  };
}

function repoFrom(row: { repo: typeof repos.$inferSelect; login: string }): ConnectedRepo {
  return {
    id: row.repo.id,
    orgId: row.repo.orgId,
    kind: row.repo.kind,
    githubId: row.repo.githubId,
    fullName: row.repo.fullName,
    defaultBranch: row.repo.defaultBranch,
    private: row.repo.private,
    continuous: row.repo.continuous,
    agentMinutes: row.repo.agentMinutes,
    connectedBy: { id: row.repo.connectedBy, login: row.login },
    connectedAt: row.repo.connectedAt.toISOString(),
  };
}
