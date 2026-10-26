import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { RegistryGrant } from "../sandbox/registry-grant.js";
import type { Database } from "./client.js";
import { registryGrants, tasks } from "./schema.js";

const PREFIX = "rg_";

/** What a customer grant gives: some accepted tasks' images, until it expires or is revoked. */
export interface CustomerGrant {
  readonly id: string;
  /** Who it was issued to, for the operator's own record. */
  readonly label: string;
  readonly taskIds: readonly number[];
  /** `<name>@sha256:…` in the task image repository, as the registry endpoint serves them. */
  readonly images: readonly string[];
  readonly withVerifier: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** A task the grant can't cover, and why. */
export class GrantRefusal extends Error {}

/**
 * Pull grants for customers who run SelfBench's tasks themselves. Unlike a sandbox's grant (a
 * signed payload that lives only as long as one pull), a customer's lasts weeks, so the password
 * only names a row: the row holds what it reaches and can be revoked at once. `repository` is the
 * task image repository; images outside it are never granted.
 */
export function createRegistryGrantStore(db: Database, secret: string, repository: string) {
  const toGrant = (row: typeof registryGrants.$inferSelect): CustomerGrant => ({
    id: row.id,
    label: row.label,
    taskIds: row.taskIds,
    images: row.images,
    withVerifier: row.withVerifier,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  });
  return {
    /** Issues a grant for `taskIds`' verified images; the password is shown only now. */
    async create(input: {
      label: string;
      taskIds: readonly number[];
      withVerifier: boolean;
      expiresAt: Date;
    }): Promise<{ grant: CustomerGrant; password: string }> {
      const ids = [...new Set(input.taskIds)];
      const rows = ids.length
        ? await db
            .select({ id: tasks.id, status: tasks.pipelineStatus, images: tasks.images })
            .from(tasks)
            .where(inArray(tasks.id, ids))
        : [];
      const images: string[] = [];
      for (const id of ids) {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row) throw new GrantRefusal(`Task ${id} does not exist`);
        if (row.status !== "accepted") throw new GrantRefusal(`Task ${id} is not accepted`);
        const exported = row.images?.registry;
        if (!exported) throw new GrantRefusal(`Task ${id} has no exported images`);
        images.push(withinRepository(repository, exported.agent));
        if (input.withVerifier && exported.verifier)
          images.push(withinRepository(repository, exported.verifier));
      }
      const [row] = await db
        .insert(registryGrants)
        .values({
          id: randomUUID(),
          label: input.label,
          taskIds: ids,
          images,
          withVerifier: input.withVerifier,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error("Registry grant was not saved");
      return { grant: toGrant(row), password: `${PREFIX}${row.id}.${signature(row.id, secret)}` };
    },
    async list(): Promise<CustomerGrant[]> {
      const rows = await db.select().from(registryGrants).orderBy(desc(registryGrants.createdAt));
      return rows.map(toGrant);
    },
    /** Resolves false when there was no live grant with that id. */
    async revoke(id: string): Promise<boolean> {
      if (!z.uuid().safeParse(id).success) return false;
      const revoked = await db
        .update(registryGrants)
        .set({ revokedAt: new Date() })
        .where(and(eq(registryGrants.id, id), isNull(registryGrants.revokedAt)))
        .returning({ id: registryGrants.id });
      return revoked.length > 0;
    },
    /** The images a presented password reaches now; undefined when forged, expired or revoked. */
    async resolve(password: string, now = new Date()): Promise<RegistryGrant | undefined> {
      if (!password.startsWith(PREFIX)) return undefined;
      const [id, mac, ...rest] = password.slice(PREFIX.length).split(".");
      if (!id || !mac || rest.length > 0 || !z.uuid().safeParse(id).success) return undefined;
      const expected = Buffer.from(signature(id, secret));
      const actual = Buffer.from(mac);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
      const [row] = await db.select().from(registryGrants).where(eq(registryGrants.id, id));
      if (!row || row.revokedAt || row.expiresAt <= now) return undefined;
      return { images: row.images, expiresAt: row.expiresAt.getTime() };
    },
  };
}

export type RegistryGrantStore = ReturnType<typeof createRegistryGrantStore>;

/** Whether a registry password is a customer grant's rather than a sandbox's. */
export function isCustomerGrantPassword(password: string): boolean {
  return password.startsWith(PREFIX);
}

function withinRepository(repository: string, image: string): string {
  if (!image.startsWith(`${repository}/`) || !image.includes("@sha256:"))
    throw new GrantRefusal(`${image} is not in the task image repository`);
  return image.slice(repository.length + 1);
}

// Scoped so a customer password can never pass for any other token signed with the same secret.
function signature(id: string, secret: string): string {
  return createHmac("sha256", secret).update(`customer-registry:${id}`).digest("base64url");
}
