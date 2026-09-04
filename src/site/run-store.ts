import type { SqlClient } from "../db/sql.js";

/** A pipeline run whose candidates count as a repository's tasks. */
export interface AttachedRun {
  readonly runId: string;
  readonly attachedBy: string;
  readonly attachedAt: string;
}

export interface RunStore {
  runsFor(repoId: number): Promise<AttachedRun[]>;
  attachRun(repoId: number, runId: string, userId: number): Promise<AttachedRun>;
  /** True when a row was removed. */
  detachRun(repoId: number, runId: string): Promise<boolean>;
}

interface RunRow {
  run_id: string;
  attached_by_login: string;
  attached_at: string | Date;
}

const SELECT = `select r.run_id, u.login as attached_by_login, r.attached_at
  from repo_runs r join users u on u.id = r.attached_by`;

export function createPostgresRunStore(
  sql: SqlClient,
  options: { now?: () => Date } = {},
): RunStore {
  const now = options.now ?? (() => new Date());
  return {
    async runsFor(repoId) {
      const rows = await sql.query<RunRow>(
        `${SELECT} where r.repo_id = $1 order by r.attached_at desc, r.run_id`,
        [repoId],
      );
      return rows.map(runFrom);
    },
    async attachRun(repoId, runId, userId) {
      await sql.query(
        `insert into repo_runs (repo_id, run_id, attached_by, attached_at) values ($1, $2, $3, $4)
         on conflict (repo_id, run_id) do nothing`,
        [repoId, runId, userId, now()],
      );
      const [row] = await sql.query<RunRow>(`${SELECT} where r.repo_id = $1 and r.run_id = $2`, [
        repoId,
        runId,
      ]);
      if (!row) throw new Error("run attach returned no row");
      return runFrom(row);
    },
    async detachRun(repoId, runId) {
      const rows = await sql.query(
        "delete from repo_runs where repo_id = $1 and run_id = $2 returning run_id",
        [repoId, runId],
      );
      return rows.length > 0;
    },
  };
}

/** Test double with the same contract. */
export function createMemoryRunStore(logins: Map<number, string>): RunStore {
  const runs = new Map<string, AttachedRun & { repoId: number }>();
  const key = (repoId: number, runId: string) => `${repoId}:${runId}`;
  return {
    async runsFor(repoId) {
      return [...runs.values()].filter((run) => run.repoId === repoId).reverse();
    },
    async attachRun(repoId, runId, userId) {
      const existing = runs.get(key(repoId, runId));
      if (existing) return existing;
      const run = {
        repoId,
        runId,
        attachedBy: logins.get(userId) ?? "",
        attachedAt: new Date().toISOString(),
      };
      runs.set(key(repoId, runId), run);
      return run;
    },
    async detachRun(repoId, runId) {
      return runs.delete(key(repoId, runId));
    },
  };
}

function runFrom(row: RunRow): AttachedRun {
  return {
    runId: row.run_id,
    attachedBy: row.attached_by_login,
    attachedAt: new Date(row.attached_at).toISOString(),
  };
}
