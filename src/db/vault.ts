import { eq } from "drizzle-orm";
import type { EvaluationScope } from "../evaluation/scope.js";
import type { Database } from "./client.js";
import { type ComparisonStore, createComparisonStore } from "./comparisons.js";
import { type CredentialStore, createCredentialStore } from "./credentials.js";
import { createEncryptedRecords, type EncryptedRecordStore } from "./encrypted-records.js";
import { createSavedHarnessStore, type SavedHarnessStore } from "./saved-harnesses.js";
import type { repos } from "./schema.js";
import { scopeTables } from "./scope-tables.js";

/** Everything sealed with the evaluation credential key, plus the comparisons that use it. */
export interface Vault {
  readonly records: EncryptedRecordStore;
  readonly credentials: CredentialStore;
  readonly comparisons: ComparisonStore;
  /** The workspace's saved harnesses, which a comparison picks by id; unsealed, like comparisons. */
  readonly harnesses?: SavedHarnessStore;
  /**
   * Current repository or benchmark ownership, checked before a queued BYOK explanation decrypts
   * a key.
   */
  readonly scopeOrg?: (scope: EvaluationScope) => Promise<number | undefined>;
}

export function createVault(db: Database, key: string): Vault {
  return {
    records: createEncryptedRecords(db, key),
    credentials: createCredentialStore(db, key),
    comparisons: createComparisonStore(db),
    harnesses: createSavedHarnessStore(db),
    async scopeOrg(scope) {
      const { owner: table, id } = scopeTables(scope);
      // Each owning table has an id and the org it belongs to.
      const owner = table as typeof repos;
      const [found] = await db.select({ orgId: owner.orgId }).from(owner).where(eq(owner.id, id));
      return found?.orgId;
    },
  };
}
