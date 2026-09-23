import type { Database } from "./client.js";
import { type ComparisonStore, createComparisonStore } from "./comparisons.js";
import { type CredentialStore, createCredentialStore } from "./credentials.js";
import { createEncryptedRecords, type EncryptedRecordStore } from "./encrypted-records.js";

/** Everything sealed with the evaluation credential key, plus the comparisons that use it. */
export interface Vault {
  readonly records: EncryptedRecordStore;
  readonly credentials: CredentialStore;
  readonly comparisons: ComparisonStore;
}

export function createVault(db: Database, key: string): Vault {
  return {
    records: createEncryptedRecords(db, key),
    credentials: createCredentialStore(db, key),
    comparisons: createComparisonStore(db),
  };
}
