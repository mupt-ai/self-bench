import { eq } from "drizzle-orm";
import type { EvaluationScope } from "../evaluation/scope.js";
import type { Database } from "./client.js";
import { type ComparisonStore, createComparisonStore } from "./comparisons.js";
import { type CredentialStore, createCredentialStore } from "./credentials.js";
import { createEncryptedRecords, type EncryptedRecordStore } from "./encrypted-records.js";
import { benchmarks, repos } from "./schema.js";

/** Everything sealed with the evaluation credential key, plus the comparisons that use it. */
export interface Vault {
  readonly records: EncryptedRecordStore;
  readonly credentials: CredentialStore;
  readonly comparisons: ComparisonStore;
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
    async scopeOrg({ repoId, benchmarkId }) {
      const [owner] =
        benchmarkId !== undefined
          ? await db
              .select({ orgId: benchmarks.orgId })
              .from(benchmarks)
              .where(eq(benchmarks.id, benchmarkId))
          : repoId !== undefined
            ? await db.select({ orgId: repos.orgId }).from(repos).where(eq(repos.id, repoId))
            : [];
      return owner?.orgId;
    },
  };
}
