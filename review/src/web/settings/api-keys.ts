import { requestJson } from "../api";

export type ApiKeyScope = "read" | "write";

/** A key as the server lists it; the secret only ever appears in the creation response. */
export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  createdAt: string;
  lastUsedAt?: string;
}

export interface CreatedApiKey {
  key: ApiKey;
  secret: string;
}

const root = "/api/api-keys";

export async function fetchApiKeys(): Promise<ApiKey[]> {
  return (await requestJson<{ keys: ApiKey[] }>(root)).keys;
}

export function createApiKey(input: { name: string; scope: ApiKeyScope }): Promise<CreatedApiKey> {
  return requestJson<CreatedApiKey>(root, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function revokeApiKey(id: number): Promise<void> {
  await requestJson<{ ok: true }>(`${root}/${id}`, { method: "DELETE" });
}

export const scopeLabels: Record<ApiKeyScope, string> = {
  read: "Read Only",
  write: "Read & Write",
};
