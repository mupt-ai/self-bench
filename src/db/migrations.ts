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
  {
    version: 4,
    name: "repo-continuous",
    sql: `
-- Opt-in: keep building tasks as pull requests merge, rather than only on demand.
alter table repos add column if not exists continuous boolean not null default false;
`,
  },
  {
    version: 5,
    name: "repo-runs-and-reviews",
    sql: `
-- Pipeline runs whose candidates count as this repository's tasks.
create table if not exists repo_runs (
  repo_id bigint not null references repos(id) on delete cascade,
  run_id text not null,
  attached_by bigint not null references users(id),
  attached_at timestamptz not null default now(),
  primary key (repo_id, run_id)
);

-- A human verdict on one task; absent means the task still needs review.
create table if not exists task_reviews (
  repo_id bigint not null references repos(id) on delete cascade,
  run_id text not null,
  task_id text not null,
  decision text not null check (decision in ('approve', 'reject')),
  note text not null default '',
  decided_by bigint not null references users(id),
  decided_at timestamptz not null default now(),
  primary key (repo_id, run_id, task_id)
);
`,
  },
  {
    version: 6,
    name: "tasks",
    sql: `
-- One row per candidate the pipeline processed; files and artifacts stay in the bucket.
create table if not exists tasks (
  id bigserial primary key,
  repo_id bigint not null references repos(id) on delete cascade,
  run_id text not null,
  candidate_id text not null,
  task_id text not null,
  source_pr integer,
  source_url text,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  pipeline_status text not null check (pipeline_status in ('in_progress', 'accepted', 'rejected', 'infrastructure_failed')),
  stage text not null,
  reason text,
  bundle_key text,
  definition jsonb,
  review_decision text check (review_decision in ('approve', 'reject')),
  review_note text,
  reviewed_by bigint references users(id),
  reviewed_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (run_id, candidate_id)
);
create index if not exists tasks_repo_id on tasks(repo_id);
create index if not exists tasks_repo_pr on tasks(repo_id, source_pr);

-- Reviews recorded before tasks had rows move onto the task; none exist outside dev.
insert into tasks (repo_id, run_id, candidate_id, task_id, difficulty, pipeline_status, stage,
  review_decision, review_note, reviewed_by, reviewed_at)
select v.repo_id, v.run_id, v.task_id, v.task_id, 'easy', 'accepted', 'accepted',
  v.decision, v.note, v.decided_by, v.decided_at
from task_reviews v
on conflict (run_id, candidate_id) do nothing;
drop table if exists task_reviews;
`,
  },
  {
    version: 7,
    name: "tasks-started-here",
    sql: `
-- Tasks the site started itself: the Temporal workflow that is (or was) building them.
alter table tasks add column if not exists workflow_id text;
alter table tasks add column if not exists started_by bigint references users(id);
alter table tasks add column if not exists started_at timestamptz;
alter table tasks add column if not exists round integer;
create unique index if not exists tasks_workflow_id on tasks(workflow_id) where workflow_id is not null;
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
