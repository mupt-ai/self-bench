import type { SqlClient } from "../db/sql.js";
import { createSecretBox, deriveKey } from "./crypto.js";
import type { GitHubProfile, OrgMembership } from "./github.js";

/** The user as routes see it. The GitHub token is deliberately not here. */
export interface User {
  readonly id: number;
  readonly githubId: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

/** A tenant the user can work in: a GitHub org, or their personal account (`kind: "user"`). */
export interface Org {
  readonly id: number;
  readonly githubId: number;
  readonly login: string;
  readonly kind: "org" | "user";
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly role: "admin" | "member";
}

export interface SignedInProfile extends GitHubProfile {
  readonly token: string;
  readonly scopes: string;
  /** Active org memberships at sign-in; the personal account is added by the store. */
  readonly orgs: readonly OrgMembership[];
}

export interface UserStore {
  /** Creates or refreshes the user, re-seals the token, and replaces their org memberships. */
  upsert(profile: SignedInProfile): Promise<User>;
  /** Looks a session's subject up; touches `last_seen_at`. Undefined when the row is gone. */
  findByGitHubId(githubId: number): Promise<User | undefined>;
  /** The user's tenants: personal account first, then orgs by login. */
  orgsFor(userId: number): Promise<Org[]>;
  /** Decrypts the stored GitHub token for server-side use (discovery); never for a browser. */
  gitHubToken(githubId: number): Promise<string | undefined>;
}

interface UserRow {
  id: string | number;
  github_id: string | number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface OrgRow extends UserRow {
  kind: "org" | "user";
  role: "admin" | "member";
}

const USER_COLUMNS = "id, github_id, login, name, avatar_url";

/** The tenants a profile implies: the personal account (as admin) plus every org membership. */
function tenantsOf(profile: SignedInProfile): Omit<Org, "id">[] {
  return [
    {
      githubId: profile.githubId,
      login: profile.login,
      kind: "user",
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      role: "admin",
    },
    ...profile.orgs.map((org) => ({ ...org, kind: "org" as const })),
  ];
}

export function createPostgresUserStore(
  sql: SqlClient,
  options: { secret: string; now?: () => Date },
): UserStore {
  const box = createSecretBox(deriveKey(options.secret, "token-sealing"));
  const now = options.now ?? (() => new Date());
  return {
    async upsert(profile) {
      return sql.transaction(async (tx) => {
        const [row] = await tx.query<UserRow>(
          `insert into users (github_id, login, name, avatar_url, github_token, github_scopes, last_seen_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (github_id) do update
             set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
                 github_token = excluded.github_token, github_scopes = excluded.github_scopes,
                 last_seen_at = excluded.last_seen_at
           returning ${USER_COLUMNS}`,
          [
            profile.githubId,
            profile.login,
            profile.name ?? null,
            profile.avatarUrl ?? null,
            box.seal(profile.token),
            profile.scopes,
            now(),
          ],
        );
        if (!row) throw new Error("user upsert returned no row");
        const user = userFrom(row);
        await tx.query("delete from org_members where user_id = $1", [user.id]);
        for (const tenant of tenantsOf(profile)) {
          const [org] = await tx.query<{ id: string | number }>(
            `insert into orgs (github_id, login, kind, name, avatar_url, updated_at)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (github_id) do update
               set login = excluded.login, kind = excluded.kind, name = excluded.name,
                   avatar_url = excluded.avatar_url, updated_at = excluded.updated_at
             returning id`,
            [
              tenant.githubId,
              tenant.login,
              tenant.kind,
              tenant.name ?? null,
              tenant.avatarUrl ?? null,
              now(),
            ],
          );
          if (!org) throw new Error("org upsert returned no row");
          await tx.query(
            "insert into org_members (org_id, user_id, role, synced_at) values ($1, $2, $3, $4)",
            [org.id, user.id, tenant.role, now()],
          );
        }
        return user;
      });
    },
    async findByGitHubId(githubId) {
      const [row] = await sql.query<UserRow>(
        `update users set last_seen_at = $2 where github_id = $1 returning ${USER_COLUMNS}`,
        [githubId, now()],
      );
      return row ? userFrom(row) : undefined;
    },
    async orgsFor(userId) {
      const rows = await sql.query<OrgRow>(
        `select o.id, o.github_id, o.login, o.kind, o.name, o.avatar_url, m.role
         from org_members m join orgs o on o.id = m.org_id
         where m.user_id = $1
         order by (o.kind = 'user') desc, lower(o.login)`,
        [userId],
      );
      return rows.map(orgFrom);
    },
    async gitHubToken(githubId) {
      const [row] = await sql.query<{ github_token: Uint8Array }>(
        "select github_token from users where github_id = $1",
        [githubId],
      );
      return row ? box.open(row.github_token) : undefined;
    },
  };
}

/** Test double with the same contract, so route tests need no database. */
export function createMemoryUserStore(): UserStore & { tokens: Map<number, string> } {
  const users = new Map<number, User>();
  const orgs = new Map<number, Org[]>();
  const tokens = new Map<number, string>();
  let nextId = 1;
  return {
    tokens,
    async upsert(profile) {
      const existing = users.get(profile.githubId);
      const user: User = {
        id: existing?.id ?? nextId++,
        githubId: profile.githubId,
        login: profile.login,
        ...(profile.name ? { name: profile.name } : {}),
        ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      };
      users.set(profile.githubId, user);
      tokens.set(profile.githubId, profile.token);
      orgs.set(
        user.id,
        tenantsOf(profile).map((tenant) => ({ ...tenant, id: tenant.githubId })),
      );
      return user;
    },
    async findByGitHubId(githubId) {
      return users.get(githubId);
    },
    async orgsFor(userId) {
      return orgs.get(userId) ?? [];
    },
    async gitHubToken(githubId) {
      return tokens.get(githubId);
    },
  };
}

function userFrom(row: UserRow): User {
  return {
    id: Number(row.id),
    githubId: Number(row.github_id),
    login: row.login,
    ...(row.name ? { name: row.name } : {}),
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
  };
}

function orgFrom(row: OrgRow): Org {
  return {
    ...userFrom(row),
    kind: row.kind,
    role: row.role,
  };
}
