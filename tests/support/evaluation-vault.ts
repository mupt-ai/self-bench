import type { ComparisonRecord, ComparisonStore } from "../../src/db/comparisons.js";
import {
  type CredentialInfo,
  type CredentialSecret,
  type CredentialStore,
  credentialSchema,
  validateEndpoint,
} from "../../src/db/credentials.js";
import { type EncryptedRecordStore, RecordStoreError } from "../../src/db/encrypted-records.js";
import type { Vault } from "../../src/db/vault.js";

export class MemoryRecords implements EncryptedRecordStore {
  private entries = new Map<string, { value: unknown; version: number }>();

  async read<Value>(path: string) {
    return structuredClone(this.entries.get(path)) as { value: Value; version: number } | undefined;
  }

  async write(path: string, value: unknown, version: number) {
    if ((this.entries.get(path)?.version ?? 0) !== version) throw new RecordStoreError(409);
    this.entries.set(path, { value: structuredClone(value), version: version + 1 });
  }

  async destroy(path: string) {
    this.entries.delete(path);
  }
}

/** An in-memory Vault with the same contract as the Postgres stores. */
export function memoryVault(records: EncryptedRecordStore = new MemoryRecords()): Vault {
  const rows = new Map<string, CredentialInfo & { orgId: number; secret?: CredentialSecret }>();
  const saved = new Map<string, ComparisonRecord>();
  const view = ({
    orgId: _org,
    secret: _secret,
    ...info
  }: CredentialInfo & {
    orgId: number;
    secret?: CredentialSecret;
  }): CredentialInfo => structuredClone(info);
  const live = (orgId: number, id: string) => {
    const row = rows.get(id);
    return row?.orgId === orgId && row.secret ? row : undefined;
  };
  const find = async (orgId: number, id: string) => {
    const row = live(orgId, id);
    return row ? view(row) : undefined;
  };
  const credentials: CredentialStore = {
    find,
    async list(orgId) {
      return [...rows.values()].filter((row) => live(orgId, row.id)).map(view);
    },
    async secret(orgId, id) {
      return structuredClone(live(orgId, id)?.secret);
    },
    async create(orgId, draft, env, id = crypto.randomUUID()) {
      const parsed = credentialSchema.parse(draft);
      const endpoint = parsed.endpoint ? validateEndpoint(parsed.endpoint, env) : undefined;
      const existing = rows.get(id);
      if (existing) {
        if (existing.orgId !== orgId) throw new RecordStoreError(409, "Credential ID already used");
        return view(existing);
      }
      const { value, tokenId, teamId, projectId } = parsed;
      rows.set(id, {
        id,
        orgId,
        name: parsed.name,
        kind: parsed.kind,
        auth: parsed.auth,
        createdAt: new Date().toISOString(),
        ...(endpoint ? { endpoint } : {}),
        secret: {
          value,
          ...(tokenId ? { tokenId } : {}),
          ...(teamId ? { teamId } : {}),
          ...(projectId ? { projectId } : {}),
        },
      });
      return (await find(orgId, id)) as CredentialInfo;
    },
    async remove(orgId, id) {
      const row = live(orgId, id);
      if (!row) throw new Error("Credential not found");
      delete row.secret;
    },
    seal: () => "",
  };
  const comparisons: ComparisonStore = {
    async find(id) {
      return structuredClone(saved.get(id));
    },
    async listForRepo(repoId) {
      return [...saved.values()].filter((record) => record.repoId === repoId);
    },
    async listForOrg(orgId) {
      return [...saved.values()].filter((record) => record.orgId === orgId);
    },
    async countForOrg(orgId) {
      return [...saved.values()].filter((record) => record.orgId === orgId).length;
    },
    async insert(record) {
      if (!saved.has(record.id)) saved.set(record.id, structuredClone(record));
      return structuredClone(saved.get(record.id) as ComparisonRecord);
    },
  };
  return { records, credentials, comparisons };
}
