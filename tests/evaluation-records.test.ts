import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { evaluationRecords } from "../src/db/schema.js";
import { createEncryptedRecords } from "../src/evaluation/encrypted-records.js";
import { testDatabase } from "./support/site-fixture.js";

test("encrypted records persist without plaintext and reject wrong keys and tampering", async () => {
  const database = await testDatabase();
  try {
    const key = "a".repeat(64);
    const records = createEncryptedRecords(database.db, key);
    const path = "credentials/1/example";
    const value = { value: "private-provider-key" };
    await records.write(path, value, 0);
    const [stored] = await database.db.select().from(evaluationRecords);
    if (!stored) throw new Error("Missing encrypted record");
    expect(stored.sealed).not.toContain(value.value);
    expect(Buffer.from(stored.sealed, "base64").toString()).not.toContain(value.value);
    expect(await createEncryptedRecords(database.db, key).read(path)).toEqual({
      value,
      version: 1,
    });
    await expect(createEncryptedRecords(database.db, "b".repeat(64)).read(path)).rejects.toThrow();
    await database.db.insert(evaluationRecords).values({ ...stored, path: "credentials/2/copied" });
    await expect(records.read("credentials/2/copied")).rejects.toThrow("integrity");
    await database.db
      .update(evaluationRecords)
      .set({ version: 2 })
      .where(eq(evaluationRecords.path, path));
    await expect(records.read(path)).rejects.toThrow("integrity");
    await records.destroy(path);
    expect(await records.read(path)).toBeUndefined();
    expect(() => createEncryptedRecords(database.db, "short")).toThrow();
  } finally {
    await database.close();
  }
});

test("encrypted record compare-and-swap permits only one concurrent writer", async () => {
  const database = await testDatabase();
  try {
    const records = createEncryptedRecords(database.db, "a".repeat(64));
    await records.write("accounts/1", { revision: 1 }, 0);
    const results = await Promise.allSettled([
      records.write("accounts/1", { revision: 2 }, 1),
      records.write("accounts/1", { revision: 3 }, 1),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await records.read("accounts/1"))?.version).toBe(2);
    await expect(records.write("accounts/1", {}, 0)).rejects.toThrow("Concurrent update");
  } finally {
    await database.close();
  }
});
