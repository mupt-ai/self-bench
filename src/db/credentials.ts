import { randomUUID } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createSecretBox } from "../api/auth/crypto.js";
import { gatewayIds } from "../gateways/index.js";
import type { Database } from "./client.js";
import { credentialEndpoint, dariEndpoint } from "./credential-endpoints.js";
import { RecordStoreError } from "./encrypted-records.js";
import { credentials } from "./schema.js";

const sandboxKinds = ["e2b", "modal", "daytona", "vercel"] as const;
const credentialKinds = [
  "dari",
  "openai",
  "anthropic",
  "meta",
  ...gatewayIds,
  "custom",
  ...sandboxKinds,
] as const;
const providerId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
/** API keys, and the subscription sign-ins of Codex (ChatGPT), Claude Code (Claude), and Muse Code (Meta). */
export const credentialAuths = ["api-key", "codex-login", "claude-login", "muse-login"] as const;
/** Claude Code's subscription token, as `claude setup-token` prints it. */
const claudeToken = /^sk-ant-oat[A-Za-z0-9_-]+$/;
/**
 * How many sandboxes use a credential at once. For a sandbox account, those it runs (its plan's
 * limit, or less to leave room for other work); for a model key or sign-in, those whose agent
 * calls it, to stay under the provider's rate limits. Generation and evaluations share the slots.
 */
export const maxSandboxesSchema = z.number().int().min(1).max(1000);

export const credentialSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(credentialKinds),
    auth: z.enum(credentialAuths).default("api-key"),
    value: z.string().min(1).max(24_000),
    tokenId: z.string().max(4096).optional(),
    // Accepted and ignored: clients written before the gateway still send an OpenRouter management
    // key, and rejecting it would fail them. Nothing reads it, and create() never stores it.
    managementKey: z.string().max(4096).optional(),
    teamId: providerId.optional(),
    projectId: providerId.optional(),
    endpoint: z.preprocess((value) => (value === "" ? undefined : value), z.url().optional()),
    maxSandboxes: maxSandboxesSchema.optional(),
    // Image builds a sandbox account runs at once; E2B counts them apart from its sandboxes.
    maxBuilds: maxSandboxesSchema.optional(),
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
    } else if (value.auth === "claude-login") {
      if (value.kind !== "anthropic" || !claudeToken.test(value.value))
        issue("Provide a Claude Code token from claude setup-token, not an API key");
    } else if (value.auth === "muse-login") {
      if (value.kind !== "meta" || !museSignIn(value.value))
        issue("Provide a Muse Code auth.json from a Meta sign-in, not an API key");
    } else if (/[\r\n\0]/.test(value.value)) issue("API keys must be a single line");
    else if (value.kind === "anthropic" && value.value.startsWith("sk-ant-oat"))
      issue("This is a Claude subscription token; add it as a Claude sign-in instead");
    if ((value.kind === "modal") !== !!value.tokenId) issue("Modal requires a token ID and secret");
    if (
      value.kind === "vercel" ? !value.teamId || !value.projectId : value.teamId || value.projectId
    )
      issue("Vercel requires a team ID and project ID; other providers do not accept them");
    if (value.kind === "custom" && !value.endpoint) issue("Custom providers require an endpoint");
    if (value.kind === "dari" && value.endpoint) {
      try {
        dariEndpoint(value.endpoint);
      } catch (cause) {
        issue(cause instanceof Error ? cause.message : "Invalid Dari router");
      }
    }
    if (value.kind !== "custom" && value.kind !== "dari" && value.endpoint)
      issue("Only custom and Dari providers accept an endpoint");
  });
export type CredentialDraft = z.infer<typeof credentialSchema>;

/** Muse Code's auth.json holding a Meta sign-in's token in the file, as SelfBench writes it. */
function museSignIn(value: string): boolean {
  try {
    const meta = JSON.parse(value).providers?.meta;
    return meta?.mechanism === "oauth" && meta.storage === "file" && !!meta.access_token;
  } catch {
    return false;
  }
}
type CredentialKind = (typeof credentialKinds)[number];

/** What the browser sees: never the secret. */
export interface CredentialInfo {
  id: string;
  name: string;
  kind: CredentialKind;
  auth: (typeof credentialAuths)[number];
  createdAt: string;
  endpoint?: string;
  maxSandboxes?: number;
  maxBuilds?: number;
}
export interface CredentialSecret {
  value: string;
  tokenId?: string;
  teamId?: string;
  projectId?: string;
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
    ...(row.maxSandboxes ? { maxSandboxes: row.maxSandboxes } : {}),
    ...(row.maxBuilds ? { maxBuilds: row.maxBuilds } : {}),
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
      const endpoint = credentialEndpoint(parsed, env);
      const existing = await find(orgId, id);
      if (existing) return existing;
      const [total] = await db
        .select({ value: count() })
        .from(credentials)
        .where(and(eq(credentials.orgId, orgId), isNull(credentials.deletedAt)));
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
          maxSandboxes: parsed.maxSandboxes,
          maxBuilds: parsed.maxBuilds,
          secret: seal(id, secret),
        })
        .onConflictDoNothing()
        .returning();
      if (row) return info(row);
      const saved = await find(orgId, id);
      if (!saved) throw new RecordStoreError(409, "Credential ID already used");
      return saved;
    },
    /**
     * Sets or clears a limit for new work: on sandboxes, or with `column` on image builds. Work
     * already started is not stopped.
     */
    async limit(
      orgId: number,
      id: string,
      value: number | undefined,
      column: "maxSandboxes" | "maxBuilds" = "maxSandboxes",
    ): Promise<void> {
      if (!(await find(orgId, id))) throw new Error("Credential not found");
      const parsed = value === undefined ? null : maxSandboxesSchema.parse(value);
      await db
        .update(credentials)
        .set({ [column]: parsed })
        .where(live(orgId, id));
    },
    /** Renames a credential; work saved with it keeps its ID, so it shows the new name. */
    async rename(orgId: number, id: string, name: string): Promise<void> {
      const [renamed] = await db
        .update(credentials)
        .set({ name: credentialSchema.shape.name.parse(name) })
        .where(live(orgId, id))
        .returning({ id: credentials.id });
      if (!renamed) throw new Error("Credential not found");
    },
    /** Replaces a sign-in's saved tokens with refreshed ones (gateway/sign-in.ts). */
    async renew(orgId: number, id: string, value: string): Promise<void> {
      await db
        .update(credentials)
        .set({ secret: seal(id, { value }) })
        .where(live(orgId, id));
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
