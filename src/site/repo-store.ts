import type { SqlClient } from "../db/sql.js";

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
  /** Connects a repo, or returns the existing row when the GitHub id is already connected. */
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

interface RepoRow {
  id: string | number;
  org_id: string | number;
  github_id: string | number;
  full_name: string;
  default_branch: string;
  private: boolean;
  continuous: boolean;
  connected_by: string | number;
  connected_by_login: string;
  connected_at: string | Date;
}

const SELECT = `select r.id, r.org_id, r.github_id, r.full_name, r.default_branch, r.private,
  r.continuous, r.connected_by, u.login as connected_by_login, r.connected_at
  from repos r join users u on u.id = r.connected_by`;

export function createPostgresRepoStore(
  sql: SqlClient,
  options: { now?: () => Date } = {},
): RepoStore {
  const now = options.now ?? (() => new Date());
  return {
    async list(orgId) {
      const rows = await sql.query<RepoRow>(
        `${SELECT} where r.org_id = $1 order by r.connected_at desc, r.id desc`,
        [orgId],
      );
      return rows.map(repoFrom);
    },
    async find(orgId, fullName) {
      const [row] = await sql.query<RepoRow>(
        `${SELECT} where r.org_id = $1 and lower(r.full_name) = lower($2)`,
        [orgId, fullName],
      );
      return row ? repoFrom(row) : undefined;
    },
    async connect(input) {
      const [inserted] = await sql.query<{ id: string | number }>(
        `insert into repos (org_id, github_id, full_name, default_branch, private, connected_by, connected_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (github_id) do update
           set full_name = excluded.full_name, default_branch = excluded.default_branch,
               private = excluded.private
         returning id`,
        [
          input.orgId,
          input.githubId,
          input.fullName,
          input.defaultBranch,
          input.private,
          input.connectedBy,
          now(),
        ],
      );
      const [row] = await sql.query<RepoRow>(`${SELECT} where r.id = $1`, [inserted?.id]);
      if (!row) throw new Error("repo connect returned no row");
      return repoFrom(row);
    },
    async disconnect(orgId, fullName) {
      const rows = await sql.query<{ id: number }>(
        "delete from repos where org_id = $1 and lower(full_name) = lower($2) returning id",
        [orgId, fullName],
      );
      return rows.length > 0;
    },
    async setContinuous(orgId, fullName, value) {
      const [updated] = await sql.query<{ id: string | number }>(
        "update repos set continuous = $3 where org_id = $1 and lower(full_name) = lower($2) returning id",
        [orgId, fullName, value],
      );
      if (!updated) return undefined;
      const [row] = await sql.query<RepoRow>(`${SELECT} where r.id = $1`, [updated.id]);
      return row ? repoFrom(row) : undefined;
    },
  };
}

/** Test double with the same contract. */
export function createMemoryRepoStore(logins: Map<number, string>): RepoStore {
  const repos = new Map<number, ConnectedRepo>();
  let nextId = 1;
  return {
    async list(orgId) {
      return [...repos.values()].filter((repo) => repo.orgId === orgId).reverse();
    },
    async find(orgId, fullName) {
      return [...repos.values()].find(
        (repo) => repo.orgId === orgId && repo.fullName.toLowerCase() === fullName.toLowerCase(),
      );
    },
    async connect(input) {
      const existing = repos.get(input.githubId);
      const repo: ConnectedRepo = {
        id: existing?.id ?? nextId++,
        orgId: existing?.orgId ?? input.orgId,
        githubId: input.githubId,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        private: input.private,
        continuous: existing?.continuous ?? false,
        connectedBy: existing?.connectedBy ?? {
          id: input.connectedBy,
          login: logins.get(input.connectedBy) ?? "",
        },
        connectedAt: existing?.connectedAt ?? new Date().toISOString(),
      };
      repos.set(input.githubId, repo);
      return repo;
    },
    async disconnect(orgId, fullName) {
      const found = await this.find(orgId, fullName);
      if (!found) return false;
      repos.delete(found.githubId);
      return true;
    },
    async setContinuous(orgId, fullName, value) {
      const found = await this.find(orgId, fullName);
      if (!found) return undefined;
      const updated = { ...found, continuous: value };
      repos.set(found.githubId, updated);
      return updated;
    },
  };
}

function repoFrom(row: RepoRow): ConnectedRepo {
  return {
    id: Number(row.id),
    orgId: Number(row.org_id),
    githubId: Number(row.github_id),
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    private: row.private,
    continuous: row.continuous,
    connectedBy: { id: Number(row.connected_by), login: row.connected_by_login },
    connectedAt: new Date(row.connected_at).toISOString(),
  };
}
