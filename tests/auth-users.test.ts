import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubConnections, orgMembers, users } from "../src/db/schema.js";
import { createUserStore } from "../src/db/users.js";
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
    const [initial] = await database.db.select().from(users).where(eq(users.githubId, 7));
    if (!initial) throw new Error("created user missing");

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
    expect(row?.createdAt.getTime()).toBe(initial.createdAt.getTime());

    clock = new Date("2026-09-06T10:00:00Z");
    expect(await store.findByGitHubId(7)).toEqual(renamed);
    const [seen] = await database.db.select().from(users).where(eq(users.githubId, 7));
    expect(seen?.lastSeenAt.toISOString()).toBe("2026-09-06T10:00:00.000Z");
    expect(await store.findByGitHubId(8)).toBeUndefined();
    expect(await store.gitHubToken(8)).toBeUndefined();
  });

  test("GitHub memberships sync on each sign-in, personal workspace first", async () => {
    const store = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const user = await store.findByGitHubId(7);
    if (!user) throw new Error("user 7 missing");
    const tenants = await store.orgsFor(user.id);
    // The personal workspace keeps the slug it was made with; its connection follows the rename.
    expect(tenants.map((org) => [org.login, org.kind, org.role])).toEqual([
      ["old-login", "user", "admin"],
      ["alpha", "org", "member"],
      ["Zeta", "org", "admin"],
    ]);
    expect(tenants[0]?.github).toEqual([{ githubId: 7, login: "new-login", kind: "user" }]);
    expect(tenants[2]?.avatarUrl).toBe("https://a/z.png");
    // Leaving Old-Org on GitHub removed the membership but kept its workspace.
    const [stale] = await database.db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.githubId, 500));
    expect(stale).toBeDefined();
    const members = await database.db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, user.id));
    expect(members).toHaveLength(3);
  });

  test("workspace roles outlive GitHub's, and invites survive leaving GitHub orgs", async () => {
    const store = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const signIn = (
      githubId: number,
      login: string,
      orgs: { githubId: number; login: string; role: "admin" | "member" }[],
    ) => store.upsert({ githubId, login, token: "t", scopes: "", orgs });
    const owner = await signIn(20, "owner", [{ githubId: 600, login: "team", role: "admin" }]);
    const team = (await store.orgsFor(owner.id)).find((org) => org.login === "team");
    if (!team) throw new Error("team workspace missing");

    const dev = await signIn(21, "dev", [{ githubId: 600, login: "team", role: "member" }]);
    expect(await store.setRole(team.id, "dev", "admin")).toBe(true);
    await signIn(21, "dev", [{ githubId: 600, login: "team", role: "member" }]);
    expect((await store.orgsFor(dev.id)).find((org) => org.id === team.id)?.role).toBe("admin");

    // Removed from the GitHub org, removed from the workspace.
    await signIn(21, "dev", []);
    expect((await store.orgsFor(dev.id)).map((org) => org.login)).toEqual(["dev"]);

    // An outsider joins by invite at sign-in and stays without any GitHub membership.
    await store.invite(team.id, "Outsider", "member", owner.id);
    const outsider = await signIn(22, "outsider", []);
    expect((await store.orgsFor(outsider.id)).map((org) => [org.login, org.role])).toEqual([
      ["outsider", "admin"],
      ["team", "member"],
    ]);
    expect(await store.invites(team.id)).toEqual([]);
    await signIn(22, "outsider", []);
    expect(await store.orgsFor(outsider.id)).toHaveLength(2);

    await expect(store.removeMember(team.id, "owner")).rejects.toThrow("at least one admin");
    await expect(
      store.invite((await store.orgsFor(owner.id))[0]?.id ?? 0, "x", "member", owner.id),
    ).rejects.toThrow("Personal workspaces");
  });

  test("a new workspace takes a free slug when its GitHub login is taken", async () => {
    const store = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const user = await store.upsert({
      githubId: 30,
      login: "someone",
      token: "t",
      scopes: "",
      orgs: [{ githubId: 700, login: "ALPHA", role: "member" }],
    });
    expect((await store.orgsFor(user.id)).map((org) => org.login)).toEqual(["someone", "ALPHA-2"]);
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
