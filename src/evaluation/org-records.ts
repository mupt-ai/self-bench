import type { EncryptedRecordStore } from "./encrypted-records.js";

/** Organization records never overlap legacy personal account or credential paths. */
export function orgRecords(records: EncryptedRecordStore, orgId?: number): EncryptedRecordStore {
  if (orgId === undefined) return records;
  if (!Number.isSafeInteger(orgId) || orgId <= 0)
    throw new Error("Invalid credential organization");
  const prefix = `organizations/${orgId}/`;
  return {
    read: (path) => records.read(`${prefix}${path}`),
    write: (path, value, version) => records.write(`${prefix}${path}`, value, version),
    destroy: (path) => records.destroy(`${prefix}${path}`),
  };
}
