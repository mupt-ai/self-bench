import { openDatabase } from "../db/client.js";
import { createEncryptedRecords } from "./encrypted-records.js";

export async function openWorkerRecords(env: NodeJS.ProcessEnv = process.env) {
  const key = env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  const url = env.SELFBENCH_DATABASE_URL;
  if (!key || !url) return undefined;
  const connection = await openDatabase(url);
  return { records: createEncryptedRecords(connection.db, key), close: () => connection.close() };
}
