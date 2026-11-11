import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrationsFolder } from "../src/db/client.js";

test("tenants become connected workspaces, and slugs alike but for case get a free suffix", async () => {
  const client = new PGlite();
  try {
    await client.waitReady;
    const files = (await readdir(migrationsFolder()))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const run = async (from: number, to: number) => {
      for (const file of files.slice(from, to))
        await client.exec(await readFile(join(migrationsFolder(), file), "utf8"));
    };
    const at = files.indexOf("0039_workspaces.sql");
    await run(0, at);
    // An org renamed on GitHub left `Acme` behind; `acme` took the name, and `acme-2` exists.
    await client.exec(`
      INSERT INTO orgs (github_id, login, kind, updated_at) VALUES
        (1, 'Acme', 'org', '2026-01-01'),
        (2, 'acme', 'org', '2026-06-01'),
        (3, 'acme-2', 'org', '2026-06-01');
    `);
    await run(at, files.length);
    const orgs = await client.query<{ login: string; github_id: number }>(
      `SELECT o.login, c.github_id FROM orgs o JOIN github_connections c ON c.org_id = o.id ORDER BY c.github_id`,
    );
    expect(orgs.rows.map((row) => [Number(row.github_id), row.login])).toEqual([
      [1, "Acme-3"],
      [2, "acme"],
      [3, "acme-2"],
    ]);
  } finally {
    await client.close();
  }
});
