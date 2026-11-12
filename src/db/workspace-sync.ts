import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { orgInvites, orgMembers } from "./schema.js";

/** How sign-in reconciles a user's workspace memberships with what GitHub lists. */

/** If the workspace has no admin left, makes its longest-standing member one. */
async function keepAnAdmin(db: Pick<Database, "select" | "update">, orgId: number) {
  const [admin] = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "admin")))
    .limit(1);
  if (admin) return;
  const [next] = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(asc(orgMembers.userId))
    .limit(1);
  if (next)
    await db
      .update(orgMembers)
      .set({ role: "admin" })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, next.userId)));
}

/**
 * GitHub no longer lists the user in the workspaces outside `kept`. Invited people stay as invited
 * members; anyone else leaves. A workspace that loses its last admin keeps one.
 */
export async function leaveGitHub(
  db: Pick<Database, "delete" | "update" | "select">,
  userId: number,
  kept: number[],
): Promise<void> {
  const notKept = kept.length ? notInArray(orgMembers.orgId, kept) : undefined;
  const dropped = await db
    .delete(orgMembers)
    .where(
      and(
        eq(orgMembers.userId, userId),
        eq(orgMembers.source, "github"),
        eq(orgMembers.invited, false),
        notKept,
      ),
    )
    .returning({ orgId: orgMembers.orgId, role: orgMembers.role });
  await db
    .update(orgMembers)
    .set({ source: "invite" })
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.source, "github"), notKept));
  for (const member of dropped) if (member.role === "admin") await keepAnAdmin(db, member.orgId);
}

/** Applies the user's pending invites. Someone already in through GitHub stays, now invited too. */
export async function acceptInvites(
  db: Pick<Database, "delete" | "insert">,
  userId: number,
  login: string,
  now: Date,
): Promise<void> {
  const invites = await db
    .delete(orgInvites)
    .where(sql`lower(${orgInvites.githubLogin}) = ${login.toLowerCase()}`)
    .returning();
  for (const invite of invites)
    await db
      .insert(orgMembers)
      .values({
        orgId: invite.orgId,
        userId,
        role: invite.role,
        source: "invite",
        invited: true,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [orgMembers.orgId, orgMembers.userId],
        set: {
          invited: true,
          // An admin invite raises the role; a member invite never lowers it.
          role: sql`case when excluded.role = 'admin' then 'admin' else ${orgMembers.role} end`,
        },
      });
}
