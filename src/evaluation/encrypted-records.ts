import { and, eq } from "drizzle-orm";
import { createSecretBox } from "../auth/crypto.js";
import type { Database } from "../db/client.js";
import { evaluationRecords } from "../db/schema.js";

export class RecordStoreError extends Error {
  constructor(
    public status: number,
    message = "Encrypted credential storage unavailable",
  ) {
    super(message);
  }
}

export interface EncryptedRecordStore {
  read<Value>(path: string): Promise<{ value: Value; version: number } | undefined>;
  write(path: string, value: unknown, version: number): Promise<void>;
  destroy(path: string): Promise<void>;
}

export function createEncryptedRecords(db: Database, key: string): EncryptedRecordStore {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new RecordStoreError(503);
  const box = createSecretBox(Buffer.from(key, "hex"));

  return {
    async read<Value>(path: string) {
      const [record] = await db
        .select()
        .from(evaluationRecords)
        .where(eq(evaluationRecords.path, path));
      if (!record) return undefined;
      let decoded: { path: string; version: number; value: Value };
      try {
        decoded = JSON.parse(box.open(Buffer.from(record.sealed, "base64")));
      } catch {
        throw new RecordStoreError(503, "Encrypted record integrity check failed");
      }
      if (decoded.path !== path || decoded.version !== record.version) {
        throw new RecordStoreError(503, "Encrypted record integrity check failed");
      }
      return { value: decoded.value, version: record.version };
    },
    async write(path, value, version) {
      const next = version + 1;
      const sealed = Buffer.from(box.seal(JSON.stringify({ path, version: next, value }))).toString(
        "base64",
      );
      const changed =
        version === 0
          ? await db
              .insert(evaluationRecords)
              .values({ path, version: next, sealed })
              .onConflictDoNothing()
              .returning({ path: evaluationRecords.path })
          : await db
              .update(evaluationRecords)
              .set({ version: next, sealed })
              .where(and(eq(evaluationRecords.path, path), eq(evaluationRecords.version, version)))
              .returning({ path: evaluationRecords.path });
      if (!changed.length) throw new RecordStoreError(409, "Concurrent update; retry");
    },
    async destroy(path) {
      await db.delete(evaluationRecords).where(eq(evaluationRecords.path, path));
    },
  };
}
