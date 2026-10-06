import { afterAll, beforeAll, expect, test } from "bun:test";
import { evaluationServer } from "./support/evaluation-fixture.js";

let server: Awaited<ReturnType<typeof evaluationServer>>;
let settings: Record<string, unknown>;
const groups = "/api/orgs/avyay/groups";
const post = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });

beforeAll(async () => {
  server = await evaluationServer();
  const save = async (kind: string) =>
    (
      await (
        await server.request(
          "/api/orgs/avyay/credentials",
          post({ kind, name: kind, value: `fake-${kind}` }),
        )
      ).json()
    ).id as string;
  settings = {
    models: [{ catalogId: "gpt-6-sol", credentialId: await save("openrouter"), harnesses: ["pi"] }],
    sandbox: "e2b",
    sandboxCredentialId: await save("e2b"),
    agentMinutes: 30,
  };
});
afterAll(async () => {
  await server.close();
});

async function createGroup(name: string, repos: string[]) {
  const response = await server.request(groups, post({ name, repos }));
  expect(response.status).toBe(201);
  return (await response.json()).group as { id: string; name: string; repos: string[] };
}

test("groups are named sets of this tenant's connected repositories", async () => {
  const group = await createGroup("Next.js Apps", ["avyay/repo", "avyay/other"]);
  expect(group.repos).toEqual(["avyay/other", "avyay/repo"]);
  // Names are unique per tenant, whatever their case.
  expect((await server.request(groups, post({ name: "next.js apps", repos: [] }))).status).toBe(
    400,
  );
  const unknown = await server.request(groups, post({ name: "Other", repos: ["avyay/missing"] }));
  expect(await unknown.json()).toEqual({ error: "avyay/missing is not connected here" });
  const detail = await (await server.request(`${groups}/${group.id}`)).json();
  // Only approved tasks count: the second repository's task has not been reviewed.
  expect(detail.group.repos).toEqual([
    { fullName: "avyay/other", approvedTasks: 0 },
    { fullName: "avyay/repo", approvedTasks: 1 },
  ]);
  const other = await createGroup("Other Apps", []);
  const clash = await server.request(
    `${groups}/${other.id}`,
    post({ name: "NEXT.JS APPS", repos: [] }, "PUT"),
  );
  expect(await clash.json()).toEqual({ error: "A group with this name already exists" });
  const renamed = await server.request(
    `${groups}/${group.id}`,
    post({ name: "Next.js", repos: ["avyay/repo"] }, "PUT"),
  );
  expect((await renamed.json()).group).toMatchObject({ name: "Next.js", repos: ["avyay/repo"] });
  // Another tenant's members never see it.
  expect((await server.request(groups, {}, 2)).status).toBe(404);
  expect((await server.request(`${groups}/${group.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await server.request(`${groups}/${group.id}`)).status).toBe(404);
});

test("a group evaluation runs the same settings as one comparison per repository", async () => {
  const group = await createGroup("Fan Out", ["avyay/repo", "avyay/other"]);
  const id = crypto.randomUUID();
  const path = `${groups}/${group.id}/evaluations`;
  const starts = server.starts.length;
  const response = await server.request(path, post({ id, ...settings }));
  expect(response.status).toBe(202);
  const detail = await response.json();
  expect(detail.groupName).toBe("Fan Out");
  expect(detail.repos).toMatchObject([
    { fullName: "avyay/other", skipped: "No approved tasks" },
    { fullName: "avyay/repo", progress: { runs: [{ status: "pending", trials: 1 }] } },
  ]);
  const started = server.starts.slice(starts);
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ repoId: server.repo.id, agentMinutes: 30 });
  expect(started[0]?.tasks.map((task) => task.taskId)).toEqual(["task-one"]);
  // The repository's own comparison list shows the comparison the group made.
  const comparisons = await (await server.request(`${server.base}/comparisons`)).json();
  expect(comparisons.comparisons.map((entry: { id: string }) => entry.id)).toContain(
    detail.repos[1].comparisonId,
  );
  // Retrying the same submission reuses every comparison; other settings under its ID are refused.
  const retried = await (await server.request(path, post({ id, ...settings }))).json();
  expect(retried.repos[1].comparisonId).toBe(detail.repos[1].comparisonId);
  expect((await server.request(path, post({ id, ...settings, agentMinutes: 45 }))).status).toBe(
    400,
  );
  const listed = await (await server.request(`${groups}/${group.id}`)).json();
  expect(listed.evaluations).toMatchObject([{ id, repos: 2, settings: { agentMinutes: 30 } }]);
  const cancelled = await server.request(`${path}/${id}/cancel`, { method: "POST" });
  expect(cancelled.status).toBe(200);
  expect(server.stops.some((stop) => stop.startsWith(`evaluation/${server.repo.id}/`))).toBe(true);
});

test("both repositories run once each has approved tasks", async () => {
  // Its own server: approving the second repository's task would change the other tests.
  const own = await evaluationServer();
  try {
    const save = async (kind: string) =>
      (
        await (
          await own.request(
            "/api/orgs/avyay/credentials",
            post({ kind, name: kind, value: `fake-${kind}` }),
          )
        ).json()
      ).id as string;
    const task = await own.tasks.find(own.secondRepo.id, "run-other", "task-other");
    if (!task) throw new Error("Missing fixture task");
    await own.tasks.review(task.id, { decision: "approve", note: "Reviewed", userId: own.user.id });
    const created = await own.request(
      groups,
      post({ name: "Both", repos: ["avyay/repo", "avyay/other"] }),
    );
    const group = (await created.json()).group as { id: string };
    const response = await own.request(
      `${groups}/${group.id}/evaluations`,
      post({
        id: crypto.randomUUID(),
        ...settings,
        models: [
          { catalogId: "gpt-6-sol", credentialId: await save("openrouter"), harnesses: ["pi"] },
        ],
        sandboxCredentialId: await save("e2b"),
      }),
    );
    const detail = await response.json();
    const ids = detail.repos.map((repo: { comparisonId: string }) => repo.comparisonId);
    expect(new Set(ids).size).toBe(2);
    expect(own.starts.map((input) => input.repoId).sort()).toEqual(
      [own.repo.id, own.secondRepo.id].sort(),
    );
  } finally {
    await own.close();
  }
});

test("settings that cannot run leave no group evaluation behind", async () => {
  const group = await createGroup("Bad Settings", ["avyay/repo"]);
  const response = await server.request(
    `${groups}/${group.id}/evaluations`,
    post({ id: crypto.randomUUID(), ...settings, sandboxCredentialId: crypto.randomUUID() }),
  );
  expect(await response.json()).toEqual({ error: "Select your matching sandbox credential" });
  expect((await (await server.request(`${groups}/${group.id}`)).json()).evaluations).toEqual([]);
});

test("resume saves and starts a comparison an interrupted submission left out", async () => {
  const group = await createGroup("Interrupted", ["avyay/repo"]);
  const id = crypto.randomUUID();
  // As a submission that saved its record and crashed before its comparison.
  await server.groups.insertEvaluation({
    id,
    orgId: (await server.users.orgsFor(server.user.id))[0]?.id ?? 0,
    groupId: group.id,
    groupName: group.name,
    signature: JSON.stringify({ groupId: group.id, id, ...settings }),
    repos: [
      {
        repoId: server.repo.id,
        fullName: "avyay/repo",
        comparisonId: crypto.randomUUID(),
        tasks: [{ runId: "run-one", taskId: "task-one" }],
      },
    ],
    createdByLogin: "avyay",
    createdAt: new Date().toISOString(),
  });
  const path = `${groups}/${group.id}/evaluations/${id}`;
  expect((await (await server.request(path)).json()).repos).toEqual([
    { fullName: "avyay/repo", unsaved: true },
  ]);
  const starts = server.starts.length;
  const resumed = await (await server.request(`${path}/resume`, { method: "POST" })).json();
  expect(resumed.repos[0]).toMatchObject({ fullName: "avyay/repo", progress: { runs: [{}] } });
  expect(server.starts.slice(starts)).toHaveLength(1);
  // The evaluation outlives its group.
  await server.request(`${groups}/${group.id}`, { method: "DELETE" });
  expect((await server.request(path)).status).toBe(200);
});

test("a group with no approved tasks cannot be evaluated", async () => {
  const group = await createGroup("Empty", []);
  const response = await server.request(
    `${groups}/${group.id}/evaluations`,
    post({ id: crypto.randomUUID(), ...settings }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Add a repository to this group first" });
});
