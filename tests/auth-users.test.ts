import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createUserStore } from "../src/auth/users.js";
import { orgMembers, orgs, users } from "../src/db/schema.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./support/site-fixture.js";

describe("user store", () => {
  let database: TestDatabase;
  let clock = new Date("2026-09-04T10:00:00Z");
  beforeAll(async () => {
    database = await testDatabase();
  });
  afterAll(async () => {
    await database.close();
  });

  test("upserts by GitHub id, seals the token at rest, and touches last_seen_at", async () => {
    const store = createUserStore(database.db, {
      secret: testAuthConfig.sessionSecret,
      now: () => clock,
    });
    const created = await store.upsert({
      githubId: 7,
      login: "old-login",
      token: "gho_first",
      scopes: "repo",
      orgs: [{ githubId: 500, login: "Old-Org", role: "member" }],
    });
    expect(created).toEqual({ id: created.id, githubId: 7, login: "old-login" });
    expect(await store.gitHubToken(7)).toBe("gho_first");

    clock = new Date("2026-09-05T10:00:00Z");
    const renamed = await store.upsert({
      githubId: 7,
      login: "new-login",
      name: "N",
      avatarUrl: "https://a/x.png",
      token: "gho_second",
      scopes: "read:user,read:org,repo",
      orgs: [
        { githubId: 501, login: "Zeta", avatarUrl: "https://a/z.png", role: "admin" },
        { githubId: 502, login: "alpha", role: "member" },
      ],
    });
    expect(renamed).toEqual({
      id: created.id,
      githubId: 7,
      login: "new-login",
      name: "N",
      avatarUrl: "https://a/x.png",
    });
    expect(await store.gitHubToken(7)).toBe("gho_second");

    const [row] = await database.db.select().from(users).where(eq(users.githubId, 7));
    expect(row?.githubToken).not.toContain("gho_second");
    expect(row?.githubScopes).toBe("read:user,read:org,repo");
    expect(row?.lastSeenAt.toISOString()).toBe("2026-09-05T10:00:00.000Z");
    expect(row?.createdAt.getTime()).toBeLessThan(clock.getTime());

    clock = new Date("2026-09-06T10:00:00Z");
    expect(await store.findByGitHubId(7)).toEqual(renamed);
    const [seen] = await database.db.select().from(users).where(eq(users.githubId, 7));
    expect(seen?.lastSeenAt.toISOString()).toBe("2026-09-06T10:00:00.000Z");
    expect(await store.findByGitHubId(8)).toBeUndefined();
    expect(await store.gitHubToken(8)).toBeUndefined();
  });

  test("memberships are replaced on each sign-in, personal account first", async () => {
    const store = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const user = await store.findByGitHubId(7);
    if (!user) throw new Error("user 7 missing");
    const tenants = await store.orgsFor(user.id);
    expect(tenants.map((org) => [org.login, org.kind, org.role])).toEqual([
      ["new-login", "user", "admin"],
      ["alpha", "org", "member"],
      ["Zeta", "org", "admin"],
    ]);
    expect(tenants[0]).toMatchObject({ githubId: 7, name: "N", avatarUrl: "https://a/x.png" });
    expect(tenants[2]?.avatarUrl).toBe("https://a/z.png");
    const stale = await database.db.select().from(orgs).where(eq(orgs.githubId, 500));
    expect(stale).toHaveLength(1);
    const members = await database.db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, user.id));
    expect(members).toHaveLength(3);
  });

  test("a different secret cannot open the stored token", async () => {
    const store = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    await store.upsert({ githubId: 9, login: "nine", token: "gho_nine", scopes: "", orgs: [] });
    const other = createUserStore(database.db, {
      secret: "another-secret-that-is-long-enough-for-the-check",
    });
    await expect(other.gitHubToken(9)).rejects.toThrow();
  });
});
