import { randomUUID } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createSecretBox } from "../api/auth/crypto.js";
import type { Database } from "./client.js";
import { RecordStoreError } from "./encrypted-records.js";
import { credentials } from "./schema.js";

const credentialKinds = [
  "openai",
  "anthropic",
  "openrouter",
  "custom",
  "e2b",
  "modal",
  "daytona",
  "vercel",
] as const;
const providerId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const credentialSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(credentialKinds),
    auth: z.enum(["api-key", "codex-login"]).default("api-key"),
    value: z.string().min(1).max(24_000),
    tokenId: z.string().max(4096).optional(),
    teamId: providerId.optional(),
    projectId: providerId.optional(),
    endpoint: z.url().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
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
        issue("Provide a Codex ChatGPT auth.json, not an API key");
      }
    } else if (/[\r\n\0]/.test(value.value)) issue("API keys must be a single line");
    if ((value.kind === "modal") !== !!value.tokenId) issue("Modal requires a token ID and secret");
    if (
      value.kind === "vercel" ? !value.teamId || !value.projectId : value.teamId || value.projectId
    )
      issue("Vercel requires a team ID and project ID; other providers do not accept them");
    if ((value.kind === "custom") !== !!value.endpoint)
      issue("Only custom providers require an endpoint");
  });
export type CredentialDraft = z.infer<typeof credentialSchema>;
type CredentialKind = (typeof credentialKinds)[number];

/** What the browser sees: never the secret. */
export interface CredentialInfo {
  id: string;
  name: string;
  kind: CredentialKind;
  auth: "api-key" | "codex-login";
  createdAt: string;
  endpoint?: string;
}
export interface CredentialSecret {
  value: string;
  tokenId?: string;
  teamId?: string;
  projectId?: string;
}

export function validateEndpoint(endpoint: string, env: NodeJS.ProcessEnv): string {
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

const CREDENTIAL_LIMIT = 200;

/** Organization credentials; the secret column is sealed with the evaluation credential key. */
export function createCredentialStore(db: Database, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new RecordStoreError(503);
  const box = createSecretBox(Buffer.from(key, "hex"));
  const info = (row: typeof credentials.$inferSelect): CredentialInfo => ({
    id: row.id,
    name: row.name,
    kind: row.kind as CredentialKind,
    auth: row.auth as CredentialInfo["auth"],
    createdAt: row.createdAt.toISOString(),
    ...(row.endpoint ? { endpoint: row.endpoint } : {}),
  });
  const live = (orgId: number, id: string) =>
    and(eq(credentials.orgId, orgId), eq(credentials.id, id), isNull(credentials.deletedAt));
  const seal = (id: string, secret: CredentialSecret) =>
    Buffer.from(box.seal(JSON.stringify({ id, secret }))).toString("base64");
  const find = async (orgId: number, id: string): Promise<CredentialInfo | undefined> => {
    if (!z.uuid().safeParse(id).success) return undefined;
    const [row] = await db.select().from(credentials).where(live(orgId, id));
    return row ? info(row) : undefined;
  };
  return {
    find,
    async list(orgId: number): Promise<CredentialInfo[]> {
      const rows = await db
        .select()
        .from(credentials)
        .where(and(eq(credentials.orgId, orgId), isNull(credentials.deletedAt)))
        .orderBy(credentials.createdAt);
      return rows.map(info);
    },
    async secret(orgId: number, id: string): Promise<CredentialSecret | undefined> {
      if (!z.uuid().safeParse(id).success) return undefined;
      const [row] = await db.select().from(credentials).where(live(orgId, id));
      if (!row?.secret) return undefined;
      try {
        const sealed = JSON.parse(box.open(Buffer.from(row.secret, "base64")));
        if (sealed.id !== row.id) throw new Error();
        return sealed.secret as CredentialSecret;
      } catch {
        throw new RecordStoreError(503, "Encrypted credential integrity check failed");
      }
    },
    /** Saving the same `id` twice is a no-op, so a retried save never duplicates. */
    async create(
      orgId: number,
      draft: CredentialDraft,
      env: NodeJS.ProcessEnv,
      id: string = randomUUID(),
    ): Promise<CredentialInfo> {
      const parsed = credentialSchema.parse(draft);
      const endpoint = parsed.endpoint ? validateEndpoint(parsed.endpoint, env) : undefined;
      const existing = await find(orgId, id);
      if (existing) return existing;
      const [total] = await db
        .select({ value: count() })
        .from(credentials)
        .where(eq(credentials.orgId, orgId));
      if ((total?.value ?? 0) >= CREDENTIAL_LIMIT) throw new Error("Credential limit reached");
      const { value, tokenId, teamId, projectId } = parsed;
      const secret: CredentialSecret = {
        value,
        ...(tokenId ? { tokenId } : {}),
        ...(teamId ? { teamId } : {}),
        ...(projectId ? { projectId } : {}),
      };
      const [row] = await db
        .insert(credentials)
        .values({
          id,
          orgId,
          name: parsed.name,
          kind: parsed.kind,
          auth: parsed.auth,
          endpoint,
          secret: seal(id, secret),
        })
        .onConflictDoNothing()
        .returning();
      if (row) return info(row);
      const saved = await find(orgId, id);
      if (!saved) throw new RecordStoreError(409, "Credential ID already used");
      return saved;
    },
    /** Soft delete: the row stays for history, the secret is erased. */
    async remove(orgId: number, id: string): Promise<void> {
      const removed = await db
        .update(credentials)
        .set({ deletedAt: new Date(), secret: null })
        .where(live(orgId, id))
        .returning({ id: credentials.id });
      if (!removed.length) throw new Error("Credential not found");
    },
    /** Seals a secret exactly as `create` does; the one-time records migration uses it. */
    seal,
  };
}
export type CredentialStore = ReturnType<typeof createCredentialStore>;
