import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { LocalArtifactStore } from "../src/artifacts.js";
import { createUserStore } from "../src/auth/users.js";
import { migrationsFolder } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { createRepoStore } from "../src/site/repo-store.js";
import { createTaskStore } from "../src/site/task-store.js";
import { testAuthConfig } from "./support/site-fixture.js";

test("dropping attachment mappings preserves tasks, reviews, tombstones, evaluations and artifacts", async () => {
  const client = new PGlite();
  const root = await mkdtemp(join(tmpdir(), "drop-repo-runs-"));
  try {
    await client.waitReady;
    for (const file of [
      "0000_glossy_johnny_blaze.sql",
      "0001_evaluation_records.sql",
      "0002_task_deletion.sql",
    ]) {
      await client.exec(await readFile(join(migrationsFolder(), file), "utf8"));
    }
    const db = drizzle(client, { schema });
    const users = createUserStore(db, { secret: testAuthConfig.sessionSecret });
    const user = await users.upsert({
      githubId: 1,
      login: "owner",
      token: "test",
      scopes: "",
      orgs: [],
    });
    const [org] = await users.orgsFor(user.id);
    if (!org) throw new Error("Missing test organization");
    const repo = await createRepoStore(db).connect({
      orgId: org.id,
      githubId: 1,
      fullName: "owner/repo",
      defaultBranch: "main",
      private: true,
      connectedBy: user.id,
    });
    const tasks = createTaskStore(db);
    const base = {
      repoId: repo.id,
      runId: "run-before",
      pipelineStatus: "accepted" as const,
      stage: "accepted",
      difficulty: "easy" as const,
      bundleKey: "history/bundle",
    };
    await tasks.upsertMany([
      { ...base, candidateId: "kept", taskId: "kept" },
      { ...base, candidateId: "deleted", taskId: "deleted" },
    ]);
    const kept = await tasks.find(repo.id, base.runId, "kept");
    if (!kept) throw new Error("Missing seeded task");
    await tasks.review(kept.id, { decision: "approve", note: "Keep review", userId: user.id });
    await tasks.deleteTask(repo.id, base.runId, "deleted");
    await db.execute(
      sql`insert into repo_runs (repo_id, run_id, attached_by) values (${repo.id}, ${base.runId}, ${user.id})`,
    );
    await db
      .insert(schema.evaluationRecords)
      .values({ path: "evaluations/historical", version: 1, sealed: "test-history" });
    const artifacts = new LocalArtifactStore(root);
    await artifacts.put("history/bundle", Buffer.from("retained"), "application/octet-stream");
    const beforeTasks = await db.select().from(schema.tasks);
    const beforeEvaluations = await db.select().from(schema.evaluationRecords);
    const migration = await readFile(join(migrationsFolder(), "0003_drop_repo_runs.sql"), "utf8");
    expect(migration.trim()).toBe('DROP TABLE "repo_runs";');
    await client.exec(migration);
    expect((await client.query("select to_regclass('public.repo_runs') as name")).rows).toEqual([
      { name: null },
    ]);
    expect(await db.select().from(schema.tasks)).toEqual(beforeTasks);
    expect(await db.select().from(schema.evaluationRecords)).toEqual(beforeEvaluations);
    expect(await tasks.listForRepo(repo.id)).toHaveLength(1);
    expect((await tasks.find(repo.id, base.runId, "kept"))?.review?.note).toBe("Keep review");
    expect(await tasks.deleteTask(repo.id, base.runId, "deleted")).toBe("deleted");
    expect(Buffer.from((await artifacts.getByKey("history/bundle")) ?? []).toString()).toBe(
      "retained",
    );
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
