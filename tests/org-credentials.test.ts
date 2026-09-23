import { expect, test } from "bun:test";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

test("organization credentials are shared by members, isolated per organization and admin-managed", async () => {
  const vault = memoryVault();
  const site = await evaluationServer(vault);
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  const draft = {
    name: "Shared Model",
    kind: "openai" as const,
    auth: "api-key" as const,
    value: "mock-shared-secret",
  };
  try {
    const tenant = (await site.users.orgsFor(site.user.id))[0];
    if (!tenant) throw new Error("Missing tenant");
    await vault.credentials.create(tenant.id + 100, { ...draft, name: "Other Org Key" }, {});
    expect((await (await site.request("/api/orgs/avyay/credentials")).json()).credentials).toEqual(
      [],
    );
    expect((await site.request("/api/orgs/avyay/credentials", {}, null)).status).toBe(401);
    expect((await site.request("/api/orgs/avyay/credentials", {}, 2)).status).toBe(404);
    expect(
      (
        await site.request("/api/orgs/avyay/credentials", {
          ...post(draft),
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const created = await site.request("/api/orgs/avyay/credentials", post(draft));
    expect(created.status).toBe(201);
    const credential = await created.json();
    expect(JSON.stringify(credential)).not.toContain(draft.value);
    const list = await (await site.request("/api/orgs/avyay/credentials")).json();
    expect(list.canManage).toBe(true);
    expect(list.credentials.map((item: { id: string }) => item.id)).toEqual([credential.id]);
    expect((await vault.credentials.list(tenant.id + 100)).map((item) => item.name)).toEqual([
      "Other Org Key",
    ]);
    const team = { githubId: 20, login: "team", role: "admin" as const };
    await site.users.upsert({
      githubId: 1,
      login: "avyay",
      token: "github-secret",
      scopes: "repo",
      orgs: [team],
    });
    await site.users.upsert({
      githubId: 2,
      login: "outsider",
      token: "other-secret",
      scopes: "repo",
      orgs: [{ ...team, role: "member" }],
    });
    const teamCredential = await (
      await site.request("/api/orgs/team/credentials", post(draft))
    ).json();
    const member = await (await site.request("/api/orgs/team/credentials", {}, 2)).json();
    expect(member.credentials.map((item: { id: string }) => item.id)).toEqual([teamCredential.id]);
    expect(member.canManage).toBe(false);
    expect((await site.request("/api/orgs/team/credentials", post(draft), 2)).status).toBe(403);
    expect(
      (await site.request(`/api/orgs/team/credentials/${teamCredential.id}/delete`, post({}), 2))
        .status,
    ).toBe(403);
    expect(
      (await site.request(`/api/orgs/team/credentials/${credential.id}/delete`, post({}))).status,
    ).toBe(400);
    expect(
      (await site.request(`/api/orgs/team/credentials/${teamCredential.id}/delete`, post({})))
        .status,
    ).toBe(200);
    expect(
      (await (await site.request("/api/orgs/avyay/credentials")).json()).credentials,
    ).toHaveLength(1);
  } finally {
    await site.close();
  }
});
