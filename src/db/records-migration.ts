/**
 * One-time copy of evaluation credentials and comparisons out of the encrypted
 * `evaluation_records` account blobs into the `credentials` and `comparisons` tables.
 *
 *   node dist/db/records-migration.js            # dry run: counts only, writes nothing
 *   node dist/db/records-migration.js --apply    # insert missing rows
 *
 * Needs SELFBENCH_DATABASE_URL and SELFBENCH_EVAL_CREDENTIAL_KEY. It is idempotent: rows keep
 * their original IDs and inserts skip IDs that already exist. The source records are left in
 * place, so rolling back the code needs no data restore. See docs/operations.md.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, like, or } from "drizzle-orm";
import type { EvaluationInput } from "../evaluation/types.js";
import { type Database, openDatabase } from "./client.js";
import {
  type CredentialInfo,
  type CredentialSecret,
  createCredentialStore,
} from "./credentials.js";
import { createEncryptedRecords } from "./encrypted-records.js";
import { comparisons, credentials, evaluationRecords, orgs } from "./schema.js";

interface LegacyAccount {
  credentials: (CredentialInfo & { deleted?: boolean; migratedFrom?: string })[];
  comparisons: {
    id: string;
    repoId: number;
    createdAt: string;
    signature: string;
    inputs: EvaluationInput[];
  }[];
}

export interface MigrationReport {
  accounts: number;
  credentials: number;
  deletedCredentials: number;
  comparisons: number;
  skipped: string[];
}

export async function migrateEvaluationRecords(
  db: Database,
  key: string,
  apply: boolean,
): Promise<MigrationReport> {
  const records = createEncryptedRecords(db, key);
  const box = createCredentialStore(db, key);
  const report: MigrationReport = {
    accounts: 0,
    credentials: 0,
    deletedCredentials: 0,
    comparisons: 0,
    skipped: [],
  };
  const paths = await db
    .select({ path: evaluationRecords.path })
    .from(evaluationRecords)
    .where(
      or(
        like(evaluationRecords.path, "accounts/%"),
        like(evaluationRecords.path, "organizations/%/accounts/%"),
      ),
    );
  for (const { path } of paths) {
    const organization = /^organizations\/(\d+)\/accounts\/(\d+)$/.exec(path);
    const personal = /^accounts\/(\d+)$/.exec(path);
    if (!organization && !personal) continue;
    // Organization accounts are keyed by org ID; personal accounts by GitHub user ID.
    const owner = Number(organization ? organization[2] : personal?.[1]);
    const prefix = organization ? `organizations/${organization[1]}/` : "";
    const orgId = organization ? Number(organization[1]) : await personalOrg(db, owner);
    if (!orgId) {
      report.skipped.push(`${path}: no personal organization for GitHub user ${owner}`);
      continue;
    }
    const account = (await records.read<LegacyAccount>(path))?.value;
    if (!account) continue;
    report.accounts += 1;
    for (const info of account.credentials) {
      const secret = info.deleted
        ? undefined
        : (await records.read<CredentialSecret>(`${prefix}credentials/${owner}/${info.id}`))?.value;
      if (secret) report.credentials += 1;
      else report.deletedCredentials += 1;
      if (!apply) continue;
      await db
        .insert(credentials)
        .values({
          id: info.id,
          orgId,
          name: info.name,
          kind: info.kind,
          auth: info.auth,
          endpoint: info.endpoint,
          secret: secret ? box.seal(info.id, secret) : null,
          createdAt: new Date(info.createdAt),
          ...(secret ? {} : { deletedAt: new Date() }),
        })
        .onConflictDoNothing();
    }
    for (const comparison of account.comparisons) {
      report.comparisons += 1;
      if (!apply) continue;
      await db
        .insert(comparisons)
        .values({
          id: comparison.id,
          orgId,
          repoId: comparison.repoId,
          signature: comparison.signature,
          // Execution resolves credentials by organization; personal inputs only had an owner.
          inputs: comparison.inputs.map((input) => ({ ...input, credentialOrgId: orgId })),
          createdAt: new Date(comparison.createdAt),
        })
        .onConflictDoNothing();
    }
  }
  return report;
}

async function personalOrg(db: Database, githubId: number): Promise<number | undefined> {
  const [org] = await db
    .select({ id: orgs.id })
    .from(orgs)
    .where(and(eq(orgs.githubId, githubId), eq(orgs.kind, "user")));
  return org?.id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.SELFBENCH_DATABASE_URL;
  const key = process.env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  if (!url || !key)
    throw new Error("Set SELFBENCH_DATABASE_URL and SELFBENCH_EVAL_CREDENTIAL_KEY.");
  const apply = process.argv.includes("--apply");
  const database = await openDatabase(url);
  try {
    const report = await migrateEvaluationRecords(database.db, key, apply);
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }, null, 2));
  } finally {
    await database.close();
  }
}
