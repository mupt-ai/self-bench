import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrationsFolder } from "../src/db/client.js";
import { credentialSchema } from "../src/db/credentials.js";
import { createVault } from "../src/db/vault.js";
import { testDatabase } from "./support/test-database.js";

const key = "a".repeat(64);

test("existing ChatGPT sign-ins without a limit take the default; others keep theirs", async () => {
  const client = new PGlite();
  try {
    await client.waitReady;
    const files = (await readdir(migrationsFolder()))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const backfill = "0031_chatgpt_sign_in_limit.sql";
    for (const file of files.slice(0, files.indexOf(backfill)))
      await client.exec(await readFile(join(migrationsFolder(), file), "utf8"));
    await client.exec(`
      INSERT INTO credentials (id, org_id, name, kind, auth, max_sandboxes, deleted_at) VALUES
        ('00000000-0000-4000-8000-000000000001', 1, 'unset', 'openai', 'codex-login', NULL, NULL),
        ('00000000-0000-4000-8000-000000000002', 1, 'set', 'openai', 'codex-login', 8, NULL),
        ('00000000-0000-4000-8000-000000000003', 1, 'key', 'openai', 'api-key', NULL, NULL),
        ('00000000-0000-4000-8000-000000000004', 1, 'gone', 'openai', 'codex-login', NULL, now());
    `);
    await client.exec(await readFile(join(migrationsFolder(), backfill), "utf8"));
    const { rows } = await client.query<{ name: string; max_sandboxes: number | null }>(
      "SELECT name, max_sandboxes FROM credentials ORDER BY id",
    );
    expect(rows).toEqual([
      { name: "unset", max_sandboxes: 50 },
      { name: "set", max_sandboxes: 8 },
      { name: "key", max_sandboxes: null },
      { name: "gone", max_sandboxes: null },
    ]);
  } finally {
    await client.close();
  }
});

test("a ChatGPT sign-in starts at 50 sandboxes at once unless given a limit, and can change it", async () => {
  const database = await testDatabase();
  try {
    const { credentials: store } = createVault(database.db, key);
    const value = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } });
    const signIn = (maxSandboxes?: number) =>
      store.create(
        1,
        credentialSchema.parse({
          name: "ChatGPT",
          kind: "openai",
          auth: "codex-login",
          value,
          ...(maxSandboxes ? { maxSandboxes } : {}),
        }),
        {},
      );
    const unset = await signIn();
    expect(unset.maxSandboxes).toBe(50);
    expect((await signIn(10)).maxSandboxes).toBe(10);
    await store.limit(1, unset.id, 200);
    expect((await store.find(1, unset.id))?.maxSandboxes).toBe(200);
    await store.limit(1, unset.id, undefined);
    expect(await store.find(1, unset.id)).not.toHaveProperty("maxSandboxes");
    // An API key keeps no limit unless given one.
    const apiKey = await store.create(
      1,
      { name: "Key", kind: "openai", auth: "api-key", value: "k" },
      {},
    );
    expect(apiKey).not.toHaveProperty("maxSandboxes");
  } finally {
    await database.close();
  }
});
