import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { orgMembers, orgs, users } from "../db/schema.js";
import { createSecretBox, deriveKey } from "./crypto.js";
import type { GitHubProfile, OrgMembership } from "./github.js";

/** The user as routes see it. The GitHub token is deliberately not here. */
export interface User {
  readonly id: number;
  readonly githubId: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

/** A tenant the user can work in: a GitHub org, or their personal account (`kind: "user"`). */
export interface Org {
  readonly id: number;
  readonly githubId: number;
  readonly login: string;
  readonly kind: "org" | "user";
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly role: "admin" | "member";
}

export interface SignedInProfile extends GitHubProfile {
  readonly token: string;
  readonly scopes: string;
  /** Active org memberships at sign-in; the personal account is added by the store. */
  readonly orgs: readonly OrgMembership[];
}

export interface UserStore {
  /** Creates or refreshes the user, re-seals the token, and replaces their org memberships. */
  upsert(profile: SignedInProfile): Promise<User>;
  /** Looks a session's subject up; touches `last_seen_at`. Undefined when the row is gone. */
  findByGitHubId(githubId: number): Promise<User | undefined>;
  /** The user's tenants: personal account first, then orgs by login. */
  orgsFor(userId: number): Promise<Org[]>;
  /** Decrypts the stored GitHub token for server-side use (discovery); never for a browser. */
  gitHubToken(githubId: number): Promise<string | undefined>;
}

/** The tenants a profile implies: the personal account (as admin) plus every org membership. */
function tenantsOf(profile: SignedInProfile): Omit<Org, "id">[] {
  return [
    {
      githubId: profile.githubId,
      login: profile.login,
      kind: "user",
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      role: "admin",
    },
    ...profile.orgs.map((org) => ({ ...org, kind: "org" as const })),
  ];
}

export function createUserStore(
  db: Database,
  options: { secret: string; now?: () => Date },
): UserStore {
  const box = createSecretBox(deriveKey(options.secret, "token-sealing"));
  const now = options.now ?? (() => new Date());
  return {
    async upsert(profile) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            githubId: profile.githubId,
            login: profile.login,
            name: profile.name ?? null,
            avatarUrl: profile.avatarUrl ?? null,
            githubToken: Buffer.from(box.seal(profile.token)).toString("base64"),
            githubScopes: profile.scopes,
            lastSeenAt: now(),
          })
          .onConflictDoUpdate({
            target: users.githubId,
            set: {
              login: profile.login,
              name: profile.name ?? null,
              avatarUrl: profile.avatarUrl ?? null,
              githubToken: Buffer.from(box.seal(profile.token)).toString("base64"),
              githubScopes: profile.scopes,
              lastSeenAt: now(),
            },
          })
          .returning();
        if (!row) throw new Error("user upsert returned no row");
        await tx.delete(orgMembers).where(eq(orgMembers.userId, row.id));
        for (const tenant of tenantsOf(profile)) {
          const [org] = await tx
            .insert(orgs)
            .values({
              githubId: tenant.githubId,
              login: tenant.login,
              kind: tenant.kind,
              name: tenant.name ?? null,
              avatarUrl: tenant.avatarUrl ?? null,
              updatedAt: now(),
            })
            .onConflictDoUpdate({
              target: orgs.githubId,
              set: {
                login: tenant.login,
                kind: tenant.kind,
                name: tenant.name ?? null,
                avatarUrl: tenant.avatarUrl ?? null,
                updatedAt: now(),
              },
            })
            .returning({ id: orgs.id });
          if (!org) throw new Error("org upsert returned no row");
          await tx
            .insert(orgMembers)
            .values({ orgId: org.id, userId: row.id, role: tenant.role, syncedAt: now() });
        }
        return userFrom(row);
      });
    },
    async findByGitHubId(githubId) {
      const [row] = await db
        .update(users)
        .set({ lastSeenAt: now() })
        .where(eq(users.githubId, githubId))
        .returning();
      return row ? userFrom(row) : undefined;
    },
    async orgsFor(userId) {
      const rows = await db
        .select({ org: orgs, role: orgMembers.role })
        .from(orgMembers)
        .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
        .where(eq(orgMembers.userId, userId))
        .orderBy(sql`(${orgs.kind} = 'user') desc`, asc(sql`lower(${orgs.login})`));
      return rows.map(({ org, role }) => ({
        id: org.id,
        githubId: org.githubId,
        login: org.login,
        kind: org.kind,
        ...(org.name ? { name: org.name } : {}),
        ...(org.avatarUrl ? { avatarUrl: org.avatarUrl } : {}),
        role,
      }));
    },
    async gitHubToken(githubId) {
      const [row] = await db
        .select({ token: users.githubToken })
        .from(users)
        .where(and(eq(users.githubId, githubId)));
      return row ? box.open(Buffer.from(row.token, "base64")) : undefined;
    },
  };
}

function userFrom(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    githubId: row.githubId,
    login: row.login,
    ...(row.name ? { name: row.name } : {}),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
  };
}
