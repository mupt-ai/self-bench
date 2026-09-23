import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createEncryptedRecords } from "../src/db/encrypted-records.js";
import { migrateEvaluationRecords } from "../src/db/records-migration.js";
import { comparisons, credentials } from "../src/db/schema.js";
import { createUserStore } from "../src/db/users.js";
import { createVault } from "../src/db/vault.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { evaluationInput } from "./support/evaluation-fixture.js";
import { testAuthConfig, testDatabase } from "./support/site-fixture.js";

const key = "a".repeat(64);

test("credentials are sealed per row, org-scoped, idempotent by ID and soft-deleted", async () => {
  const database = await testDatabase();
  try {
    const { credentials: store } = createVault(database.db, key);
    const draft = { name: "Model", kind: "openai", auth: "api-key", value: "row-secret" } as const;
    const id = crypto.randomUUID();
    const saved = await store.create(1, draft, {}, id);
    expect(await store.create(1, { ...draft, name: "Retry" }, {}, id)).toEqual(saved);
    await expect(store.create(2, draft, {}, id)).rejects.toThrow("already used");
    const [row] = await database.db.select().from(credentials).where(eq(credentials.id, id));
    expect(row?.secret).not.toContain("row-secret");
    expect(await store.secret(1, id)).toEqual({ value: "row-secret" });
    expect(await store.find(2, id)).toBeUndefined();
    expect(await store.secret(2, id)).toBeUndefined();
    // A sealed secret copied onto another row fails the integrity check.
    const other = await store.create(1, { ...draft, value: "other" }, {});
    await database.db
      .update(credentials)
      .set({ secret: row?.secret ?? "" })
      .where(eq(credentials.id, other.id));
    await expect(store.secret(1, other.id)).rejects.toThrow("integrity");
    await expect(
      createVault(database.db, "b".repeat(64)).credentials.secret(1, id),
    ).rejects.toThrow("integrity");
    await store.remove(1, id);
    expect(await store.find(1, id)).toBeUndefined();
    expect((await store.list(1)).map((item) => item.id)).toEqual([other.id]);
    await expect(store.remove(1, id)).rejects.toThrow("not found");
  } finally {
    await database.close();
  }
});

test("the records migration copies org and personal accounts once, keeping IDs", async () => {
  const database = await testDatabase();
  try {
    const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    await users.upsert({ githubId: 42, login: "person", token: "t", scopes: "", orgs: [] });
    const personal = (await users.orgsFor((await users.findByGitHubId(42))?.id ?? 0))[0];
    if (!personal) throw new Error("Missing personal organization");
    const records = createEncryptedRecords(database.db, key);
    const ids = { org: crypto.randomUUID(), gone: crypto.randomUUID(), mine: crypto.randomUUID() };
    const info = (id: string, deleted?: boolean) => ({
      id,
      name: "Key",
      kind: "openai",
      auth: "api-key",
      createdAt: "2026-09-01T00:00:00.000Z",
      ...(deleted ? { deleted } : {}),
    });
    const input = (credentialOwnerId: number, orgId?: number): EvaluationInput => ({
      ...evaluationInput(),
      credentialOwnerId,
      ...(orgId ? { credentialOrgId: orgId } : {}),
      comparisonId: "c",
    });
    const orgComparison = crypto.randomUUID();
    const personalComparison = crypto.randomUUID();
    await records.write(
      "organizations/7/accounts/7",
      {
        credentials: [info(ids.org), info(ids.gone, true)],
        comparisons: [
          {
            id: orgComparison,
            repoId: 1,
            createdAt: "2026-09-02T00:00:00.000Z",
            signature: "s",
            inputs: [input(7, 7)],
          },
        ],
      },
      0,
    );
    await records.write(`organizations/7/credentials/7/${ids.org}`, { value: "org-secret" }, 0);
    await records.write(
      "accounts/42",
      {
        credentials: [info(ids.mine)],
        comparisons: [
          {
            id: personalComparison,
            repoId: 1,
            createdAt: "2026-09-03T00:00:00.000Z",
            signature: "s",
            inputs: [input(42)],
          },
        ],
      },
      0,
    );
    await records.write(`credentials/42/${ids.mine}`, { value: "my-secret" }, 0);
    await records.write(
      "accounts/99",
      { credentials: [info(crypto.randomUUID())], comparisons: [] },
      0,
    );

    const dryRun = await migrateEvaluationRecords(database.db, key, false);
    expect(dryRun).toMatchObject({
      accounts: 2,
      credentials: 2,
      deletedCredentials: 1,
      comparisons: 2,
    });
    expect(dryRun.skipped).toEqual(["accounts/99: no personal organization for GitHub user 99"]);
    expect(await database.db.select().from(credentials)).toEqual([]);

    await migrateEvaluationRecords(database.db, key, true);
    await migrateEvaluationRecords(database.db, key, true);
    const vault = createVault(database.db, key);
    expect(await vault.credentials.secret(7, ids.org)).toEqual({ value: "org-secret" });
    expect(await vault.credentials.secret(personal.id, ids.mine)).toEqual({ value: "my-secret" });
    expect(await vault.credentials.find(7, ids.gone)).toBeUndefined();
    expect(await database.db.select().from(credentials)).toHaveLength(3);
    expect(await database.db.select().from(comparisons)).toHaveLength(2);
    const migrated = await vault.comparisons.find(personalComparison);
    expect(migrated?.orgId).toBe(personal.id);
    expect(migrated?.inputs[0]?.credentialOrgId).toBe(personal.id);
    expect((await vault.comparisons.find(orgComparison))?.createdAt).toBe(
      "2026-09-02T00:00:00.000Z",
    );
  } finally {
    await database.close();
  }
});
