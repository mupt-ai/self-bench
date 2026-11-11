import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { githubConnections, orgInvites, orgMembers, orgs, users } from "./schema.js";

type WorkspaceRole = "admin" | "member";

interface WorkspaceMember {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly role: WorkspaceRole;
  /** "github" when the membership comes from a connected GitHub organization. */
  readonly source: "github" | "invite";
}

interface WorkspaceInvite {
  readonly id: number;
  readonly githubLogin: string;
  readonly role: WorkspaceRole;
  readonly createdAt: string;
}

/** A change refused because it breaks a workspace rule; the message is safe to show. */
export class WorkspaceError extends Error {}

/** Membership and invitations of a workspace, all addressed by the workspace's id. */
export interface WorkspaceStore {
  members(orgId: number): Promise<WorkspaceMember[]>;
  invites(orgId: number): Promise<WorkspaceInvite[]>;
  /** Invites a GitHub login, or updates the role of a pending invite to it. */
  invite(
    orgId: number,
    githubLogin: string,
    role: WorkspaceRole,
    invitedBy: number,
  ): Promise<WorkspaceInvite>;
  revokeInvite(orgId: number, inviteId: number): Promise<boolean>;
  /** Sets a member's role; refuses to demote the last admin. */
  setRole(orgId: number, login: string, role: WorkspaceRole): Promise<boolean>;
  /**
   * Removes an invited member; refuses the last admin, and anyone a connected GitHub organization
   * brings in, since sign-in would add them back.
   */
  removeMember(orgId: number, login: string): Promise<boolean>;
  /** Makes a shared workspace with `userId` as its admin; the slug must be free. */
  create(
    login: string,
    name: string | null,
    userId: number,
  ): Promise<{ id: number; login: string }>;
  /**
   * Moves a GitHub organization's connection into `orgId`. `userId` must administer the workspace
   * it is connected to now. Its members join `orgId` at their next sign-in.
   */
  moveConnection(orgId: number, githubLogin: string, userId: number): Promise<void>;
  /**
   * Sets the display name. The slug stays: public release and group addresses are built from it.
   */
  rename(orgId: number, name: string | null): Promise<void>;
}

export function createWorkspaceStore(db: Database): WorkspaceStore {
  const userIdOf = async (login: string) =>
    (
      await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.login}) = ${login.toLowerCase()}`)
    )[0]?.id;

  const assertOtherAdmin = async (orgId: number, userId: number) => {
    const [other] = await db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, orgId),
          eq(orgMembers.role, "admin"),
          ne(orgMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!other) throw new WorkspaceError("A workspace needs at least one admin");
  };

  return {
    async members(orgId) {
      const rows = await db
        .select({
          login: users.login,
          name: users.name,
          avatarUrl: users.avatarUrl,
          role: orgMembers.role,
          source: orgMembers.source,
        })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(eq(orgMembers.orgId, orgId))
        .orderBy(asc(sql`lower(${users.login})`));
      return rows.map(({ name, avatarUrl, ...row }) => ({
        ...row,
        ...(name ? { name } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      }));
    },
    async invites(orgId) {
      const rows = await db
        .select()
        .from(orgInvites)
        .where(eq(orgInvites.orgId, orgId))
        .orderBy(asc(orgInvites.createdAt));
      return rows.map(inviteFrom);
    },
    async invite(orgId, githubLogin, role, invitedBy) {
      const [org] = await db.select({ kind: orgs.kind }).from(orgs).where(eq(orgs.id, orgId));
      if (org?.kind !== "org")
        throw new WorkspaceError("Personal workspaces have no other members");
      const existing = await userIdOf(githubLogin);
      if (existing !== undefined) {
        const [member] = await db
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, existing)));
        if (member) throw new WorkspaceError(`${githubLogin} is already a member`);
      }
      const pending = and(
        eq(orgInvites.orgId, orgId),
        sql`lower(${orgInvites.githubLogin}) = ${githubLogin.toLowerCase()}`,
      );
      const [updated] = await db
        .update(orgInvites)
        .set({ role, invitedBy })
        .where(pending)
        .returning();
      const [row] = updated
        ? [updated]
        : await db.insert(orgInvites).values({ orgId, githubLogin, role, invitedBy }).returning();
      if (!row) throw new Error("invite insert returned no row");
      return inviteFrom(row);
    },
    async revokeInvite(orgId, inviteId) {
      const rows = await db
        .delete(orgInvites)
        .where(and(eq(orgInvites.orgId, orgId), eq(orgInvites.id, inviteId)))
        .returning({ id: orgInvites.id });
      return rows.length > 0;
    },
    async setRole(orgId, login, role) {
      const userId = await userIdOf(login);
      if (userId === undefined) return false;
      if (role !== "admin") await assertOtherAdmin(orgId, userId);
      const rows = await db
        .update(orgMembers)
        .set({ role })
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
        .returning({ userId: orgMembers.userId });
      return rows.length > 0;
    },
    async removeMember(orgId, login) {
      const userId = await userIdOf(login);
      if (userId === undefined) return false;
      const [member] = await db
        .select({ source: orgMembers.source })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
      if (!member) return false;
      if (member.source === "github")
        throw new WorkspaceError(
          `${login} is a member through a connected GitHub organization; remove them there`,
        );
      await assertOtherAdmin(orgId, userId);
      const rows = await db
        .delete(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
        .returning({ userId: orgMembers.userId });
      return rows.length > 0;
    },
    async create(login, name, userId) {
      return db.transaction(async (tx) => {
        const [taken] = await tx
          .select({ id: orgs.id })
          .from(orgs)
          .where(sql`lower(${orgs.login}) = ${login.toLowerCase()}`);
        if (taken) throw new WorkspaceError(`${login} is taken`);
        const [org] = await tx
          .insert(orgs)
          .values({ login, kind: "org", name })
          .returning({ id: orgs.id, login: orgs.login });
        if (!org) throw new Error("workspace insert returned no row");
        await tx
          .insert(orgMembers)
          .values({ orgId: org.id, userId, role: "admin", source: "invite", invited: true });
        return org;
      });
    },
    async moveConnection(orgId, githubLogin, userId) {
      const [target] = await db.select({ kind: orgs.kind }).from(orgs).where(eq(orgs.id, orgId));
      if (target?.kind !== "org")
        throw new WorkspaceError("GitHub organizations connect to shared workspaces only");
      const [connection] = await db
        .select({
          githubId: githubConnections.githubId,
          orgId: githubConnections.orgId,
          kind: githubConnections.kind,
        })
        .from(githubConnections)
        .where(sql`lower(${githubConnections.login}) = ${githubLogin.toLowerCase()}`);
      if (connection?.kind !== "org")
        throw new WorkspaceError(
          `${githubLogin} is not a GitHub organization SelfBench has seen; a member signs in first`,
        );
      if (connection.orgId === orgId) return;
      const [admin] = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, connection.orgId), eq(orgMembers.userId, userId)));
      if (admin?.role !== "admin")
        throw new WorkspaceError(`Only an admin of the workspace ${githubLogin} is in can move it`);
      await db.transaction(async (tx) => {
        await tx
          .update(githubConnections)
          .set({ orgId, updatedAt: new Date() })
          .where(eq(githubConnections.githubId, connection.githubId));
        // A workspace left with no GitHub connection keeps the people it had, as invited members,
        // so its repositories and results stay reachable.
        const [remaining] = await tx
          .select({ githubId: githubConnections.githubId })
          .from(githubConnections)
          .where(eq(githubConnections.orgId, connection.orgId))
          .limit(1);
        if (!remaining)
          await tx
            .update(orgMembers)
            .set({ source: "invite", invited: true })
            .where(eq(orgMembers.orgId, connection.orgId));
      });
    },
    async rename(orgId, name) {
      await db.update(orgs).set({ name, updatedAt: new Date() }).where(eq(orgs.id, orgId));
    },
  };
}

function inviteFrom(row: typeof orgInvites.$inferSelect): WorkspaceInvite {
  return {
    id: row.id,
    githubLogin: row.githubLogin,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}
