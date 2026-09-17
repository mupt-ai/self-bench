import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrationsFolder } from "../src/db/client.js";

test("workspace-scoping migration preserves existing repository IDs and dependent runs", async () => {
  const db = new PGlite();
  try {
    for (const file of [
      "0000_glossy_johnny_blaze.sql",
      "0001_evaluation_records.sql",
      "0002_task_deletion.sql",
      "0003_drop_repo_runs.sql",
      "0004_preserve_batch_runs.sql",
      "0005_api_keys.sql",
    ]) {
      await db.exec(await readFile(join(migrationsFolder(), file), "utf8"));
    }
    await db.exec(`
      INSERT INTO users (id, github_id, login, github_token) VALUES (1, 1, 'owner', 'sealed');
      INSERT INTO orgs (id, github_id, login, kind) VALUES (1, 1, 'owner', 'user'), (2, 2, 'team', 'org');
      INSERT INTO repos (id, org_id, github_id, full_name, default_branch, private, connected_by)
        VALUES (1, 1, 99, 'owner/repo', 'main', false, 1);
      INSERT INTO repo_runs (repo_id, run_id, attached_by) VALUES (1, 'batch-preserved', 1);
    `);
    const before = await db.query("SELECT * FROM repos");
    await db.exec(
      await readFile(join(migrationsFolder(), "0006_scope_repo_connections.sql"), "utf8"),
    );
    expect((await db.query("SELECT * FROM repos")).rows).toEqual(before.rows);
    await db.exec(`INSERT INTO repos (id, org_id, github_id, full_name, default_branch, private, connected_by)
      VALUES (2, 2, 99, 'owner/repo', 'main', false, 1)`);
    await expect(
      db.exec(`INSERT INTO repos (id, org_id, github_id, full_name, default_branch, private, connected_by)
      VALUES (3, 2, 99, 'owner/repo', 'main', false, 1)`),
    ).rejects.toThrow();
    await db.exec("DELETE FROM repos WHERE id=2");
    expect((await db.query("SELECT * FROM repos")).rows).toEqual(before.rows);
    expect((await db.query("SELECT run_id FROM repo_runs")).rows).toEqual([
      { run_id: "batch-preserved" },
    ]);
  } finally {
    await db.close();
  }
});
