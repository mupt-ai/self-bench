import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { repos, users } from "../db/schema.js";

/** A repository connected to a tenant. */
export interface ConnectedRepo {
  readonly id: number;
  readonly orgId: number;
  readonly githubId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  /** Keep building tasks as pull requests merge; off means on demand only. */
  readonly continuous: boolean;
  readonly connectedBy: { readonly id: number; readonly login: string };
  readonly connectedAt: string;
}

export interface ConnectRepoInput {
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
  /** True when a row was removed. */
  disconnect(orgId: number, fullName: string): Promise<boolean>;
  /** Undefined when the repo is not connected to this tenant. */
  setContinuous(
    orgId: number,
    fullName: string,
    value: boolean,
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
          target: repos.githubId,
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
    async disconnect(orgId, fullName) {
      const rows = await db
        .delete(repos)
        .where(byName(orgId, fullName))
        .returning({ id: repos.id });
      return rows.length > 0;
    },
    async setContinuous(orgId, fullName, value) {
      const [row] = await db
        .update(repos)
        .set({ continuous: value })
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
    githubId: row.repo.githubId,
    fullName: row.repo.fullName,
    defaultBranch: row.repo.defaultBranch,
    private: row.repo.private,
    continuous: row.repo.continuous,
    connectedBy: { id: row.repo.connectedBy, login: row.login },
    connectedAt: row.repo.connectedAt.toISOString(),
  };
}
