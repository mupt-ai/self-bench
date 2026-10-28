import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrationsFolder } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { createUserStore } from "../src/db/users.js";
import { testAuthConfig } from "./support/site-fixture.js";

const commit = (digit: string) => digit.repeat(40);

test("existing tasks take their base commit from their definition, or else their batch", async () => {
  const client = new PGlite();
  try {
    await client.waitReady;
    const files = (await readdir(migrationsFolder()))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const backfill = "0026_task_base_commit.sql";
    for (const file of files.slice(0, files.indexOf(backfill))) {
      await client.exec(await readFile(join(migrationsFolder(), file), "utf8"));
    }
    const users = createUserStore(drizzle(client, { schema }), {
      secret: testAuthConfig.sessionSecret,
    });
    const user = await users.upsert({ githubId: 1, login: "o", token: "t", scopes: "", orgs: [] });
    const [org] = await users.orgsFor(user.id);
    await client.query(
      "INSERT INTO repos (org_id, github_id, full_name, default_branch, private, connected_by) VALUES ($1, 1, 'o/r', 'main', true, $2)",
      [org?.id, user.id],
    );
    await client.exec(`
      INSERT INTO generation_batches (run_id, state) VALUES ('batch', '{"candidates": [
        {"candidate": {"candidateId": "running", "baseCommit": "${commit("B")}"}}
      ]}'), ('discovering', '{}');
      INSERT INTO tasks (repo_id, run_id, candidate_id, task_id, difficulty, pipeline_status, stage, definition)
      VALUES
        (1, 'old', 'authored', 'authored', 'easy', 'accepted', 'accepted', '{"baseCommit": "${commit("A")}"}'),
        (1, 'batch', 'running', 'running', 'easy', 'in_progress', 'authoring', NULL),
        (1, 'discovering', 'unknown', 'unknown', 'easy', 'in_progress', 'queued', '{"baseCommit": "HEAD"}');
    `);
    await client.exec(await readFile(join(migrationsFolder(), backfill), "utf8"));
    const { rows } = await client.query<{ candidate_id: string; base_commit: string | null }>(
      "SELECT candidate_id, base_commit FROM tasks ORDER BY id",
    );
    expect(rows).toEqual([
      { candidate_id: "authored", base_commit: commit("a") },
      { candidate_id: "running", base_commit: commit("b") },
      { candidate_id: "unknown", base_commit: null },
    ]);
  } finally {
    await client.close();
  }
});
