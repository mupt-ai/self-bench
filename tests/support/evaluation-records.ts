import {
  type EncryptedRecordStore,
  RecordStoreError,
} from "../../src/evaluation/encrypted-records.js";

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
