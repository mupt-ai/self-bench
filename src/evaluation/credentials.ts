import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts.js";
import { type CredentialInfo, readAccount, secretPath, updateAccount } from "./account.js";
import type { EncryptedRecordStore } from "./encrypted-records.js";
import { getEvaluation } from "./store.js";

const secret = z.string().min(1).max(24_000);
export const credentialSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum([
      "openai",
      "anthropic",
      "openrouter",
      "custom",
      "e2b",
      "modal",
      "daytona",
      "vercel",
    ]),
    auth: z.enum(["api-key", "codex-login"]).default("api-key"),
    value: secret,
    tokenId: z.string().max(4096).optional(),
    teamId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    endpoint: z.url().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.auth === "codex-login") {
      try {
        const json = JSON.parse(value.value);
        if (
          value.kind !== "openai" ||
          !json.tokens?.access_token ||
          !json.tokens?.refresh_token ||
          json.OPENAI_API_KEY
        )
          throw new Error();
      } catch {
        context.addIssue({
          code: "custom",
          message: "Provide a Codex ChatGPT auth.json, not an API key",
        });
      }
    } else if (/[\r\n\0]/.test(value.value))
      context.addIssue({ code: "custom", message: "API keys must be a single line" });
    if ((value.kind === "modal") !== !!value.tokenId)
      context.addIssue({ code: "custom", message: "Modal requires a token ID and secret" });
    if (
      value.kind === "vercel" ? !value.teamId || !value.projectId : value.teamId || value.projectId
    )
      context.addIssue({
        code: "custom",
        message: "Vercel requires a team ID and project ID; other providers do not accept them",
      });
    if ((value.kind === "custom") !== !!value.endpoint)
      context.addIssue({ code: "custom", message: "Only custom providers require an endpoint" });
  });
export type CredentialDraft = z.infer<typeof credentialSchema>;
export async function validateEndpoint(endpoint: string, env: NodeJS.ProcessEnv) {
  const url = new URL(endpoint);
  const allowed = (env.SELFBENCH_CUSTOM_MODEL_HOSTS ?? "").split(",").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowed.includes(url.hostname) ||
    (url.port && url.port !== "443")
  )
    throw new Error("Custom endpoint must use HTTPS on an operator-approved hostname");
  return url.toString().replace(/\/$/, "");
}
export async function saveCredential(
  records: EncryptedRecordStore,
  ownerId: number,
  draft: CredentialDraft,
  env: NodeJS.ProcessEnv,
  migratedFrom?: string,
): Promise<CredentialInfo> {
  const parsed = credentialSchema.parse(draft);
  const endpoint = parsed.endpoint ? await validateEndpoint(parsed.endpoint, env) : undefined;
  const current = await readAccount(records, ownerId);
  const migrated = migratedFrom
    ? current.credentials.find((entry) => entry.migratedFrom === migratedFrom && !entry.deleted)
    : undefined;
  if (migrated) return migrated;
  if (current.credentials.length >= 200) throw new Error("Credential limit reached");
  const info: CredentialInfo = {
    id: randomUUID(),
    name: parsed.name,
    kind: parsed.kind,
    auth: parsed.auth,
    createdAt: new Date().toISOString(),
    ...(endpoint ? { endpoint } : {}),
    ...(migratedFrom ? { migratedFrom } : {}),
  };
  await records.write(
    secretPath(ownerId, info.id),
    {
      value: parsed.value,
      ...(parsed.tokenId ? { tokenId: parsed.tokenId } : {}),
      ...(parsed.teamId ? { teamId: parsed.teamId } : {}),
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    },
    0,
  );
  const saved = await updateAccount(records, ownerId, async (account) => {
    if (migratedFrom) {
      const existing = account.credentials.find(
        (entry) => entry.migratedFrom === migratedFrom && !entry.deleted,
      );
      if (existing) return existing;
    }
    if (account.credentials.length >= 200) throw new Error("Credential limit reached");
    account.credentials.push(info);
    return info;
  });
  if (saved.id !== info.id) await records.destroy(secretPath(ownerId, info.id));
  return saved;
}
export async function deleteCredential(
  records: EncryptedRecordStore,
  store: ArtifactStore,
  ownerId: number,
  id: string,
) {
  await updateAccount(records, ownerId, async (account) => {
    const info = account.credentials.find((entry) => entry.id === id);
    if (!info) throw new Error("Credential not found");
    for (const comparison of account.comparisons) {
      for (const input of comparison.inputs) {
        if (
          input.credentials?.modelCredentialId !== id &&
          input.credentials?.sandboxCredentialId !== id
        )
          continue;
        const run = await getEvaluation(store, input.repoId, input.id);
        if (!run || run.status === "queued" || run.status === "running")
          throw new Error("Credential is needed by an active or pending comparison");
      }
    }
    info.deleted = true;
  });
  await records.destroy(secretPath(ownerId, id));
}
export async function listCredentials(records: EncryptedRecordStore, ownerId: number) {
  return (await readAccount(records, ownerId)).credentials
    .filter((entry) => !entry.deleted)
    .map(({ migratedFrom: _migration, ...info }) => info);
}
