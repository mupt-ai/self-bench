import type { CatalogProvider, HostedSandbox } from "./catalog.js";
import { type EncryptedRecordStore, RecordStoreError } from "./encrypted-records.js";
import type { EvaluationInput } from "./types.js";

export interface CredentialInfo {
  id: string;
  name: string;
  kind: CatalogProvider | HostedSandbox;
  auth: "api-key" | "codex-login";
  createdAt: string;
  endpoint?: string;
  deleted?: boolean;
  migratedFrom?: string;
}
export interface ComparisonRecord {
  id: string;
  repoId: number;
  ownerId: number;
  createdAt: string;
  signature: string;
  inputs: EvaluationInput[];
}
export interface CredentialAccount {
  credentials: CredentialInfo[];
  comparisons: ComparisonRecord[];
}
export function accountPath(ownerId: number) {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error("Invalid credential owner");
  return `accounts/${ownerId}`;
}
export function secretPath(ownerId: number, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid credential ID");
  return `credentials/${ownerId}/${id}`;
}
export async function readAccount(
  records: EncryptedRecordStore,
  ownerId: number,
): Promise<CredentialAccount> {
  return (
    (await records.read<CredentialAccount>(accountPath(ownerId)))?.value ?? {
      credentials: [],
      comparisons: [],
    }
  );
}
export async function updateAccount<Result>(
  records: EncryptedRecordStore,
  ownerId: number,
  change: (account: CredentialAccount) => Promise<Result>,
): Promise<Result> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await records.read<CredentialAccount>(accountPath(ownerId));
    const account = current?.value ?? { credentials: [], comparisons: [] };
    const result = await change(account);
    try {
      await records.write(accountPath(ownerId), account, current?.version ?? 0);
      return result;
    } catch (error) {
      if (!(error instanceof RecordStoreError) || error.status !== 409) throw error;
    }
  }
  throw new RecordStoreError(409, "Credential settings changed concurrently. Retry.");
}
