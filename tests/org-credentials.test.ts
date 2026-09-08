import { expect, test } from "bun:test";
import { listCredentials, saveCredential } from "../src/evaluation/credentials.js";
import { orgRecords } from "../src/evaluation/org-records.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { MemoryRecords } from "./support/evaluation-records.js";

test("organization credentials are shared across repositories, isolated from personal accounts and admin-managed", async () => {
  const records = new MemoryRecords();
  const site = await evaluationServer(records);
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  const draft = {
    name: "Shared Model",
    kind: "openai",
    auth: "api-key",
    value: "mock-shared-secret",
  };
  try {
    await saveCredential(
      records,
      1,
      { ...draft, kind: "openai", auth: "api-key", name: "Private Key" },
      {},
    );
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
    for (const repo of ["repo", "other"]) {
      const found = await (
        await site.request(`/api/orgs/avyay/repos/avyay/${repo}/evaluations/credentials`)
      ).json();
      expect(found.credentials.map((item: { id: string }) => item.id)).toEqual([credential.id]);
    }
    expect(await listCredentials(orgRecords(records, 2), 2)).toEqual([]);
    expect((await listCredentials(records, 1)).map((item) => item.name)).toEqual(["Private Key"]);
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
