import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPostgresUserStore } from "../src/auth/users.js";
import { migrate, migrations } from "../src/db/migrations.js";
import type { SqlClient } from "../src/db/sql.js";
import { migratedClient, testAuthConfig } from "./support/site-fixture.js";

describe("postgres user store", () => {
  let sql: SqlClient;
  let clock = new Date("2026-09-04T10:00:00Z");
  beforeAll(async () => {
    sql = await migratedClient();
  });
  afterAll(async () => {
    await sql.close();
  });

  test("migrations apply once and record their versions", async () => {
    expect(await migrate(sql)).toEqual([]);
    const rows = await sql.query<{ version: number }>(
      "select version from schema_migrations order by version",
    );
    expect(rows.map((row) => row.version)).toEqual(migrations.map((entry) => entry.version));
  });

  test("upserts by GitHub id, seals the token at rest, and touches last_seen_at", async () => {
    const store = createPostgresUserStore(sql, {
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

    const [row] = await sql.query<{
      github_token: Uint8Array;
      github_scopes: string;
      created_at: Date;
      last_seen_at: Date;
    }>(
      "select github_token, github_scopes, created_at, last_seen_at from users where github_id = 7",
    );
    expect(Buffer.from(row?.github_token ?? []).toString("utf8")).not.toContain("gho_second");
    expect(row?.github_scopes).toBe("read:user,read:org,repo");
    expect(new Date(row?.last_seen_at ?? 0).toISOString()).toBe("2026-09-05T10:00:00.000Z");
    expect(new Date(row?.created_at ?? 0).getTime()).toBeLessThan(clock.getTime());

    clock = new Date("2026-09-06T10:00:00Z");
    expect(await store.findByGitHubId(7)).toEqual(renamed);
    const [seen] = await sql.query<{ last_seen_at: Date }>(
      "select last_seen_at from users where github_id = 7",
    );
    expect(new Date(seen?.last_seen_at ?? 0).toISOString()).toBe("2026-09-06T10:00:00.000Z");
    expect(await store.findByGitHubId(8)).toBeUndefined();
    expect(await store.gitHubToken(8)).toBeUndefined();
  });

  test("memberships are replaced on each sign-in, personal account first", async () => {
    const store = createPostgresUserStore(sql, { secret: testAuthConfig.sessionSecret });
    const user = await store.findByGitHubId(7);
    if (!user) throw new Error("user 7 missing");
    const orgs = await store.orgsFor(user.id);
    expect(orgs.map((org) => [org.login, org.kind, org.role])).toEqual([
      ["new-login", "user", "admin"],
      ["alpha", "org", "member"],
      ["Zeta", "org", "admin"],
    ]);
    expect(orgs[0]).toMatchObject({ githubId: 7, name: "N", avatarUrl: "https://a/x.png" });
    expect(orgs[2]?.avatarUrl).toBe("https://a/z.png");
    const [stale] = await sql.query<{ count: string | number }>(
      "select count(*) as count from orgs where github_id = 500",
    );
    expect(Number(stale?.count)).toBe(1);
    const [members] = await sql.query<{ count: string | number }>(
      "select count(*) as count from org_members where user_id = $1",
      [user.id],
    );
    expect(Number(members?.count)).toBe(3);
  });

  test("a different secret cannot open the stored token", async () => {
    const store = createPostgresUserStore(sql, { secret: testAuthConfig.sessionSecret });
    await store.upsert({ githubId: 9, login: "nine", token: "gho_nine", scopes: "", orgs: [] });
    const other = createPostgresUserStore(sql, {
      secret: "another-secret-that-is-long-enough-for-the-check",
    });
    await expect(other.gitHubToken(9)).rejects.toThrow();
  });
});
