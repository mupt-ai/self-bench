import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrationsFolder } from "../src/db/client.js";

test("provider sign-ins and per-kind Dari rows are deleted, their tokens erased; keys and connections stay", async () => {
  const client = new PGlite();
  try {
    await client.waitReady;
    const files = (await readdir(migrationsFolder()))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const retire = "0043_retire_provider_sign_ins.sql";
    for (const file of files.slice(0, files.indexOf(retire)))
      await client.exec(await readFile(join(migrationsFolder(), file), "utf8"));
    await client.exec(`
      INSERT INTO credentials (id, org_id, name, kind, auth, secret) VALUES
        ('00000000-0000-4000-8000-000000000001', 1, 'chatgpt', 'openai', 'codex-login', 's'),
        ('00000000-0000-4000-8000-000000000002', 1, 'claude', 'anthropic', 'claude-login', 's'),
        ('00000000-0000-4000-8000-000000000003', 1, 'meta', 'meta', 'muse-login', 's'),
        ('00000000-0000-4000-8000-000000000004', 1, 'per-kind', 'openai', 'dari-link', 's'),
        ('00000000-0000-4000-8000-000000000005', 1, 'dari', 'dari-link', 'dari-link', 's'),
        ('00000000-0000-4000-8000-000000000006', 1, 'key', 'openai', 'api-key', 's');
    `);
    await client.exec(await readFile(join(migrationsFolder(), retire), "utf8"));
    const { rows } = await client.query<{ name: string; gone: boolean; secret: string | null }>(
      "SELECT name, deleted_at IS NOT NULL AS gone, secret FROM credentials ORDER BY id",
    );
    expect(rows).toEqual([
      { name: "chatgpt", gone: true, secret: null },
      { name: "claude", gone: true, secret: null },
      { name: "meta", gone: true, secret: null },
      { name: "per-kind", gone: true, secret: null },
      { name: "dari", gone: false, secret: "s" },
      { name: "key", gone: false, secret: "s" },
    ]);
  } finally {
    await client.close();
  }
});
