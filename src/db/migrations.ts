import type { SqlClient } from "./sql.js";

/** Advisory lock key that serializes concurrent API instances applying migrations. */
const MIGRATION_LOCK = 7_3120_2026;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Schema history for the site database, oldest first. Each entry runs once, in its own
 * transaction, and is recorded in `schema_migrations`. Never edit an applied entry; add one.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "users",
    sql: `
create table if not exists users (
  id bigserial primary key,
  github_id bigint not null unique,
  login text not null,
  name text,
  avatar_url text,
  -- AES-256-GCM sealed under a key derived from SELFBENCH_SESSION_SECRET; never served.
  github_token bytea not null,
  github_scopes text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists users_login on users(login);
`,
  },
  {
    version: 2,
    name: "orgs",
    sql: `
-- A tenant: a GitHub organization, or a user's personal account (kind = 'user').
create table if not exists orgs (
  id bigserial primary key,
  github_id bigint not null unique,
  login text not null,
  kind text not null check (kind in ('org', 'user')),
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orgs_login on orgs(login);

-- Refreshed from GitHub on every sign-in; the site trusts this, not a live call.
create table if not exists org_members (
  org_id bigint not null references orgs(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  synced_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_id on org_members(user_id);
`,
  },
  {
    version: 3,
    name: "repos",
    sql: `
-- A repository connected to a tenant; tasks accumulate under it as pull requests merge.
create table if not exists repos (
  id bigserial primary key,
  org_id bigint not null references orgs(id) on delete cascade,
  github_id bigint not null unique,
  full_name text not null,
  default_branch text not null,
  private boolean not null default false,
  connected_by bigint not null references users(id),
  connected_at timestamptz not null default now()
);
create index if not exists repos_org_id on repos(org_id);
`,
  },
];

/** Applies every migration the database has not seen yet; returns the versions applied. */
export async function migrate(
  sql: SqlClient,
  list: readonly Migration[] = migrations,
): Promise<number[]> {
  await sql.exec(
    "create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())",
  );
  const applied: number[] = [];
  for (const migration of [...list].sort((left, right) => left.version - right.version)) {
    const done = await sql.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      const seen = await tx.query<{ version: number }>(
        "select version from schema_migrations where version = $1",
        [migration.version],
      );
      if (seen.length > 0) return false;
      await tx.exec(migration.sql);
      await tx.query("insert into schema_migrations (version, name) values ($1, $2)", [
        migration.version,
        migration.name,
      ]);
      return true;
    });
    if (done) applied.push(migration.version);
  }
  return applied;
}
