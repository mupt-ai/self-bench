import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrationsFolder } from "../src/db/client.js";

test("task images keep exported pairs by digest and drop provider-only records", async () => {
  const client = new PGlite();
  try {
    await client.waitReady;
    await client.exec("create table tasks (id int primary key, images jsonb)");
    const agent = `us-central1-docker.pkg.dev/p/selfbench-tasks/t@sha256:${"a".repeat(64)}`;
    const verifier = `us-central1-docker.pkg.dev/p/selfbench-tasks/t@sha256:${"b".repeat(64)}`;
    const rows = [
      { provider: "modal", agent: "im-A", verifier: "im-B", registry: { agent, verifier } },
      { provider: "e2b", agent: "tmpl", verifier: "tmpl2" },
      { provider: "modal", agent: "im-A", registry: { agent } },
      { agent, verifier },
      null,
    ];
    for (const [index, images] of rows.entries())
      await client.query("insert into tasks values ($1, $2)", [index, images]);
    const migration = await readFile(
      join(migrationsFolder(), "0022_task_images_by_digest.sql"),
      "utf8",
    );
    await client.exec(migration);
    // A second run (a replayed deploy) changes nothing.
    await client.exec(migration);
    const after = await client.query<{ images: unknown }>("select images from tasks order by id");
    expect(after.rows.map((row) => row.images)).toEqual([
      { agent, verifier },
      null,
      null,
      { agent, verifier },
      null,
    ]);
  } finally {
    await client.close();
  }
});
