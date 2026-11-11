import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { createSecretBox, deriveKey } from "../api/auth/crypto.js";
import type { GitHubProfile, OrgMembership } from "../third_party/github/oauth.js";
import type { Database } from "./client.js";
import { githubConnections, orgInvites, orgMembers, orgs, users } from "./schema.js";
import { createWorkspaceStore, type WorkspaceStore } from "./workspaces.js";

/** How an API-key request identifies itself; absent on cookie sessions. */
export interface ApiKeyRef {
  readonly id: number;
  readonly name: string;
  readonly scope: "read" | "write";
}

/** The user as routes see it. The GitHub token is deliberately not here. */
export interface User {
  readonly id: number;
  readonly githubId: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /** Set when the request authenticated with an API key rather than a browser session. */
  readonly apiKey?: ApiKeyRef;
}

/** A GitHub account attached to a workspace. */
interface GitHubAccount {
  readonly githubId: number;
  readonly login: string;
  readonly kind: "org" | "user";
}

/**
 * A workspace the user can work in: their personal one (`kind: "user"`) or a shared one. `login`
 * is the workspace's slug, which need not match any GitHub account; `github` lists the accounts
 * connected to it.
 */
export interface Org {
  readonly id: number;
  readonly login: string;
  readonly kind: "org" | "user";
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly role: "admin" | "member";
  readonly github: readonly GitHubAccount[];
}

interface SignedInProfile extends GitHubProfile {
  readonly token: string;
  readonly scopes: string;
  /** Active org memberships at sign-in; the personal account is added by the store. */
  readonly orgs: readonly OrgMembership[];
}

export interface UserStore extends WorkspaceStore {
  /** Creates or refreshes the user, re-seals the token, and syncs their GitHub-derived memberships. */
  upsert(profile: SignedInProfile): Promise<User>;
  /** Looks a session's subject up; touches `last_seen_at`. Undefined when the row is gone. */
  findByGitHubId(githubId: number): Promise<User | undefined>;
  /** The user's tenants: personal account first, then orgs by login. */
  orgsFor(userId: number): Promise<Org[]>;
  /** Decrypts the stored GitHub token for server-side use (discovery); never for a browser. */
  gitHubToken(githubId: number): Promise<string | undefined>;
}

/** The GitHub accounts a profile belongs to: the personal account (as admin), then its orgs. */
function accountsOf(profile: SignedInProfile) {
  return [
    {
      githubId: profile.githubId,
      login: profile.login,
      kind: "user" as const,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      role: "admin" as const,
    },
    ...profile.orgs.map((org) => ({ ...org, kind: "org" as const, name: undefined })),
  ];
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** `wanted`, or `wanted-2`, `wanted-3`, … : the first slug no workspace has taken. */
async function freeSlug(tx: Tx, wanted: string): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ login: orgs.login })
        .from(orgs)
        .where(
          sql`lower(${orgs.login}) like ${`${wanted.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`}`,
        )
    ).map((row) => row.login.toLowerCase()),
  );
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n += 1) {
    const slug = `${wanted}-${n}`;
    if (!taken.has(slug.toLowerCase())) return slug;
  }
}

export function createUserStore(
  db: Database,
  options: { secret: string; now?: () => Date },
): UserStore {
  const box = createSecretBox(deriveKey(options.secret, "token-sealing"));
  const now = options.now ?? (() => new Date());
  return {
    ...createWorkspaceStore(db),
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
            createdAt: now(),
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
        // Each GitHub account the user belongs to maps to its workspace, made on first sight.
        const kept: number[] = [];
        for (const account of accountsOf(profile)) {
          const [connection] = await tx
            .update(githubConnections)
            .set({ login: account.login, updatedAt: now() })
            .where(eq(githubConnections.githubId, account.githubId))
            .returning({ orgId: githubConnections.orgId });
          let orgId = connection?.orgId;
          if (orgId === undefined) {
            const [org] = await tx
              .insert(orgs)
              .values({
                login: await freeSlug(tx, account.login),
                kind: account.kind,
                name: account.name ?? null,
                avatarUrl: account.avatarUrl ?? null,
                createdAt: now(),
                updatedAt: now(),
              })
              .returning({ id: orgs.id });
            if (!org) throw new Error("workspace insert returned no row");
            orgId = org.id;
            await tx.insert(githubConnections).values({
              githubId: account.githubId,
              orgId,
              login: account.login,
              kind: account.kind,
              createdAt: now(),
              updatedAt: now(),
            });
          }
          kept.push(orgId);
          // GitHub's role seeds a new membership; after that the workspace's own role stands.
          await tx
            .insert(orgMembers)
            .values({
              orgId,
              userId: row.id,
              role: account.role,
              source: "github",
              syncedAt: now(),
            })
            .onConflictDoUpdate({
              target: [orgMembers.orgId, orgMembers.userId],
              set: { syncedAt: now() },
            });
        }
        // Gone from a connected GitHub org means gone from its workspace; invited members stay.
        await tx
          .delete(orgMembers)
          .where(
            and(
              eq(orgMembers.userId, row.id),
              eq(orgMembers.source, "github"),
              kept.length ? notInArray(orgMembers.orgId, kept) : undefined,
            ),
          );
        // Invitations to this login are accepted on sign-in.
        const invites = await tx
          .delete(orgInvites)
          .where(sql`lower(${orgInvites.githubLogin}) = ${profile.login.toLowerCase()}`)
          .returning();
        for (const invite of invites) {
          await tx
            .insert(orgMembers)
            .values({
              orgId: invite.orgId,
              userId: row.id,
              role: invite.role,
              source: "invite",
              syncedAt: now(),
            })
            .onConflictDoNothing();
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
      const connections = rows.length
        ? await db
            .select()
            .from(githubConnections)
            .where(
              inArray(
                githubConnections.orgId,
                rows.map(({ org }) => org.id),
              ),
            )
            .orderBy(asc(sql`lower(${githubConnections.login})`))
        : [];
      return rows.map(({ org, role }) => ({
        id: org.id,
        login: org.login,
        kind: org.kind,
        ...(org.name ? { name: org.name } : {}),
        ...(org.avatarUrl ? { avatarUrl: org.avatarUrl } : {}),
        role,
        github: connections
          .filter((connection) => connection.orgId === org.id)
          .map(({ githubId, login, kind }) => ({ githubId, login, kind })),
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
