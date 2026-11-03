import { expect, test } from "bun:test";
import { createGroupStore } from "../src/db/groups.js";
import { saveEvaluation } from "../src/evaluation/store.js";
import {
  create,
  fixture,
  group,
  groupRun,
  groupSuite,
  isPrivate,
  json,
  request,
} from "./support/group-fixture.js";

groupSuite();

test("a group is created from connected repositories and runs on all their tasks", async () => {
  expect((await create()).status).toBe(201);
  const listed = await json<{ groups: { slug: string; tasks: number }[] }>("/api/orgs/acme/groups");
  expect(listed.groups).toMatchObject([{ slug: "python-web", tasks: 4 }]);
  const options = await json<{ tasks: { taskId: string; repository: string }[] }>(
    "/api/orgs/acme/groups/python-web/evaluations/options",
  );
  expect(options.tasks.map((task) => `${task.repository}:${task.taskId}`).sort()).toEqual([
    "django/django:t1",
    "django/django:t2",
    "pallets/flask:t1",
    "pallets/flask:t2",
  ]);
  const unknown = await request("/api/orgs/acme/groups", {
    method: "POST",
    body: JSON.stringify({ ...group, slug: "other", repositoryIds: [11, 99] }),
  });
  expect(unknown.status).toBe(400);
  expect((await create()).status).toBe(409);
});

test("a group's release scores its own runs over the group and on each repository", async () => {
  await create();
  const groupId =
    (await createGroupStore(fixture.database.db).find(fixture.orgId, "python-web"))?.id ?? 0;
  await saveEvaluation(
    fixture.artifacts,
    groupRun({ groupId }, "sol", { 11: ["t1", "t2"], 22: ["t1"] }),
  );
  const base = "/api/orgs/acme/groups/python-web/releases";
  const view = await json<{
    preview: { fingerprint: string; settings: { key: string }[] };
  }>(`${base}/preview`);
  expect(view.preview.settings).toHaveLength(1);
  const body = {
    settings: view.preview.settings.map((setting) => setting.key),
    head: null,
    fingerprint: view.preview.fingerprint,
  };
  // Only public repositories' groups can be released.
  isPrivate[22] = true;
  const refused = await request(base, { method: "POST", body: JSON.stringify(body) });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("django/django is private");
  isPrivate[22] = false;
  expect((await request(base, { method: "POST", body: JSON.stringify(body) })).status).toBe(201);

  const page = await request("/api/public/groups/acme/python-web");
  expect(page.status).toBe(200);
  const { group: shown } = await page.json();
  expect(shown).toMatchObject({ name: "Python Web", tasks: 4 });
  expect(shown.settings[0]).toMatchObject({ passed: 3, tasks: 4, accuracy: 75 });
  const scores = shown.members.map(
    (member: {
      repository: { fullName: string };
      scores: Record<string, { accuracy: number }>;
    }) => [member.repository.fullName, Object.values(member.scores)[0]?.accuracy],
  );
  expect(scores).toEqual([
    ["pallets/flask", 100],
    ["django/django", 50],
  ]);
  const directory = await (await request("/api/public/results")).json();
  expect(directory.groups).toMatchObject([{ slug: "python-web" }]);

  // Withdrawing takes it down; deleting the group would leave a release as it was.
  const { releases } = await json<{ releases: { id: string }[] }>(base);
  await request(`${base}/${releases[0]?.id}/withdraw`, { method: "POST" });
  expect((await request("/api/public/groups/acme/python-web")).status).toBe(404);
});
