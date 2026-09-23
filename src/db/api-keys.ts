import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { bearerToken } from "../lib/util.js";
import type { Database } from "./client.js";
import { apiKeys, users } from "./schema.js";
import type { ApiKeyRef, User } from "./users.js";

export const API_KEY_PREFIX = "sbk_";
export type ApiKeyScope = ApiKeyRef["scope"];
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ["read", "write"];
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

/** A key as the owner sees it after creation: everything but the secret. */
interface ApiKeyInfo {
  readonly id: number;
  readonly name: string;
  readonly prefix: string;
  readonly scope: ApiKeyScope;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface ApiKeyStore {
  /** Mints a key; the returned secret is the only copy that will ever exist in plaintext. */
  create(
    userId: number,
    input: { name: string; scope: ApiKeyScope },
  ): Promise<{
    key: ApiKeyInfo;
    secret: string;
  }>;
  /** Active keys for a user, newest first. Revoked keys are not listed. */
  list(userId: number): Promise<ApiKeyInfo[]>;
  /** Revokes one of the user's keys; false when it is not theirs or is already revoked. */
  revoke(userId: number, keyId: number): Promise<boolean>;
  /** Resolves a presented secret to its owner, touching `last_used_at`; undefined when unknown or revoked. */
  authenticate(secret: string): Promise<User | undefined>;
}

/** Thrown when a request presents an API key that does not resolve; answered with a 401. */
export class ApiKeyError extends Error {
  readonly status = 401;
  constructor(message = "invalid API key") {
    super(message);
  }
}

/** The secret a request carries, from `Authorization: Bearer sbk_…` or `X-API-Key`; else undefined. */
export function presentedApiKey(headers: {
  authorization?: string | undefined;
  "x-api-key"?: string | string[] | undefined;
}): string | undefined {
  const explicit = headers["x-api-key"];
  const header = Array.isArray(explicit) ? explicit[0] : explicit;
  if (header?.trim()) return header.trim();
  const bearer = bearerToken(headers.authorization);
  return bearer?.startsWith(API_KEY_PREFIX) ? bearer : undefined;
}

/** Read keys may only read: anything but GET/HEAD/OPTIONS is refused with this message. */
export function apiKeyDenies(user: User, method: string | undefined): string | undefined {
  if (!user.apiKey || user.apiKey.scope === "write") return undefined;
  if (["GET", "HEAD", "OPTIONS"].includes(method ?? "GET")) return undefined;
  return "this API key is read-only";
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createApiKeyStore(db: Database, options: { now?: () => Date } = {}): ApiKeyStore {
  const now = options.now ?? (() => new Date());
  return {
    async create(userId, input) {
      const secret = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
      const [row] = await db
        .insert(apiKeys)
        .values({
          userId,
          name: input.name,
          prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
          keyHash: hashApiKey(secret),
          scope: input.scope,
          createdAt: now(),
        })
        .returning();
      if (!row) throw new Error("api key insert returned no row");
      return { key: infoFrom(row), secret };
    },
    async list(userId) {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
      return rows.map(infoFrom);
    },
    async revoke(userId, keyId) {
      const revoked = await db
        .update(apiKeys)
        .set({ revokedAt: now() })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      return revoked.length > 0;
    },
    async authenticate(secret) {
      if (!secret.startsWith(API_KEY_PREFIX)) return undefined;
      const [found] = await db
        .select({ key: apiKeys, user: users })
        .from(apiKeys)
        .innerJoin(users, eq(users.id, apiKeys.userId))
        .where(and(eq(apiKeys.keyHash, hashApiKey(secret)), isNull(apiKeys.revokedAt)));
      if (!found) return undefined;
      await db.update(apiKeys).set({ lastUsedAt: now() }).where(eq(apiKeys.id, found.key.id));
      return {
        id: found.user.id,
        githubId: found.user.githubId,
        login: found.user.login,
        ...(found.user.name ? { name: found.user.name } : {}),
        ...(found.user.avatarUrl ? { avatarUrl: found.user.avatarUrl } : {}),
        apiKey: { id: found.key.id, name: found.key.name, scope: found.key.scope },
      };
    },
  };
}

function infoFrom(row: typeof apiKeys.$inferSelect): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
  };
}
