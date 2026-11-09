import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrationsFolder } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { createUserStore } from "../src/db/users.js";
import { testAuthConfig } from "./support/site-fixture.js";

/** Applies the journal's migrations in order, up to and including `last`. */
async function migrate(client: PGlite, from: string | undefined, last: string) {
  const journal = JSON.parse(
    await readFile(join(migrationsFolder(), "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const tags = journal.entries.map((entry) => entry.tag);
  const start = from ? tags.indexOf(from) + 1 : 0;
  for (const tag of tags.slice(start, tags.indexOf(last) + 1))
    await client.exec(await readFile(join(migrationsFolder(), `${tag}.sql`), "utf8"));
}

test("variants made as task rows move to task_variants as they stood", async () => {
  const client = new PGlite();
  try {
    await client.waitReady;
    await migrate(client, undefined, "0037_benchmark_releases");
    const db = drizzle(client, { schema });
    const users = createUserStore(db, { secret: testAuthConfig.sessionSecret });
    const user = await users.upsert({
      githubId: 1,
      login: "owner",
      token: "t",
      scopes: "",
      orgs: [],
    });
    const [org] = await users.orgsFor(user.id);
    const [repo] = await db
      .insert(schema.repos)
      .values({
        orgId: org?.id ?? 0,
        githubId: 1,
        fullName: "owner/repo",
        defaultBranch: "main",
        private: true,
        connectedBy: user.id,
      })
      .returning();
    const ids = { repo: repo?.id ?? 0, user: user.id };
    await client.exec(`
      INSERT INTO tasks (id, repo_id, run_id, candidate_id, task_id, difficulty, pipeline_status,
        stage, bundle_key, review_decision)
        VALUES (1, ${ids.repo}, 'run-task', 'cand', 'fix-it', 'easy', 'accepted', 'accepted',
        'runs/run-task/harbor-task.tar.gz', 'approve');
      INSERT INTO tasks (id, repo_id, run_id, candidate_id, task_id, difficulty, pipeline_status,
        stage, bundle_key, revised_from, feedback, variant, started_by)
        VALUES (2, ${ids.repo}, 'run-variant', 'cand', 'fix-it', 'easy', 'accepted', 'accepted',
        'runs/run-variant/harbor-task.tar.gz', 1, 'Variant: Docs', 'Docs', ${ids.user});
      INSERT INTO tasks (id, repo_id, run_id, candidate_id, task_id, difficulty, pipeline_status,
        stage, revised_from, feedback, variant, review_decision)
        VALUES (3, ${ids.repo}, 'run-rejected', 'cand', 'fix-it', 'easy', 'accepted', 'accepted', 1,
        'Variant: Old', 'Old', 'reject');
      -- A variant of a variant moves under the task they both change.
      INSERT INTO tasks (id, repo_id, run_id, candidate_id, task_id, difficulty, pipeline_status,
        stage, revised_from, feedback, variant)
        VALUES (5, ${ids.repo}, 'run-nested', 'cand', 'fix-it', 'easy', 'accepted', 'accepted', 2,
        'Variant: Docs and Next', 'Docs and Next');
      -- A revision made from a variant keeps its row, without the link.
      INSERT INTO tasks (id, repo_id, run_id, candidate_id, task_id, difficulty, pipeline_status,
        stage, revised_from, feedback)
        VALUES (4, ${ids.repo}, 'run-revision', 'cand', 'fix-it', 'easy', 'in_progress', 'authoring', 2,
        'Tighten the tests');
    `);
    await migrate(client, "0037_benchmark_releases", "0038_task_variant_records");

    const tasks = await client.query<{ id: number; revised_from: number | null }>(
      "SELECT id, revised_from FROM tasks ORDER BY id",
    );
    expect(tasks.rows.map((row) => [Number(row.id), row.revised_from])).toEqual([
      [1, null],
      [4, null],
    ]);
    const variants = await client.query<{
      parent_id: number;
      label: string;
      run_id: string;
      task_id: string;
      pipeline_status: string;
      bundle_key: string | null;
      started_by: number | null;
      deleted: boolean;
    }>(
      `SELECT parent_id, label, run_id, task_id, pipeline_status, bundle_key, started_by,
        deleted_at IS NOT NULL AS deleted FROM task_variants ORDER BY run_id`,
    );
    expect(variants.rows.map((row) => ({ ...row, parent_id: Number(row.parent_id) }))).toEqual([
      {
        parent_id: 1,
        label: "Docs and Next",
        run_id: "run-nested",
        task_id: "fix-it",
        pipeline_status: "accepted",
        bundle_key: null,
        started_by: null,
        deleted: false,
      },
      {
        parent_id: 1,
        label: "Old",
        run_id: "run-rejected",
        task_id: "fix-it",
        pipeline_status: "accepted",
        bundle_key: null,
        started_by: null,
        deleted: true,
      },
      {
        parent_id: 1,
        label: "Docs",
        run_id: "run-variant",
        task_id: "fix-it",
        pipeline_status: "accepted",
        bundle_key: "runs/run-variant/harbor-task.tar.gz",
        started_by: expect.anything(),
        deleted: false,
      },
    ]);
  } finally {
    await client.close();
  }
});
