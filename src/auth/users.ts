import type { SqlClient } from "../db/sql.js";
import { createSecretBox, deriveKey } from "./crypto.js";
import type { GitHubProfile } from "./github.js";

/** The user as routes see it. The GitHub token is deliberately not here. */
export interface User {
  readonly id: number;
  readonly githubId: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export interface SignedInProfile extends GitHubProfile {
  readonly token: string;
  readonly scopes: string;
}

export interface UserStore {
  /** Creates or refreshes the row for a GitHub account and re-seals its current token. */
  upsert(profile: SignedInProfile): Promise<User>;
  /** Looks a session's subject up; touches `last_seen_at`. Undefined when the row is gone. */
  findByGitHubId(githubId: number): Promise<User | undefined>;
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

const USER_COLUMNS = "id, github_id, login, name, avatar_url";

export function createPostgresUserStore(
  sql: SqlClient,
  options: { secret: string; now?: () => Date },
): UserStore {
  const box = createSecretBox(deriveKey(options.secret, "token-sealing"));
  const now = options.now ?? (() => new Date());
  return {
    async upsert(profile) {
      const [row] = await sql.query<UserRow>(
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
      return userFrom(row);
    },
    async findByGitHubId(githubId) {
      const [row] = await sql.query<UserRow>(
        `update users set last_seen_at = $2 where github_id = $1 returning ${USER_COLUMNS}`,
        [githubId, now()],
      );
      return row ? userFrom(row) : undefined;
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
      return user;
    },
    async findByGitHubId(githubId) {
      return users.get(githubId);
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
