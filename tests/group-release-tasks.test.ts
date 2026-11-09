import { expect, test } from "bun:test";
import { createGroupStore } from "../src/db/groups.js";
import { saveEvaluation } from "../src/evaluation/store.js";
import {
  create,
  fixture,
  groupRun,
  groupSuite,
  json,
  REPOS,
  request,
} from "./support/group-fixture.js";

groupSuite();

const RELEASES = "/api/orgs/acme/groups/python-web/releases";

test("a group publishes its tasks and trials as a repository does, each task naming its member", async () => {
  await create();
  const [flask, django] = REPOS;
  // Sol ran from the group; luna on each member on its own. Both count, as on the Results page.
  const id = (await createGroupStore(fixture.database.db).find(fixture.orgId, "python-web"))?.id;
  await saveEvaluation(
    fixture.artifacts,
    groupRun({ groupId: id ?? 0 }, "sol", { 11: ["t1"], 22: ["t1"] }),
  );
  await saveEvaluation(
    fixture.artifacts,
    groupRun({ repoId: flask?.repoId ?? 0 }, "luna", { 11: ["t1", "t2"] }, [11]),
  );
  await saveEvaluation(
    fixture.artifacts,
    groupRun({ repoId: django?.repoId ?? 0 }, "luna", { 22: [] }, [22]),
  );

  const view = await json<{
    head: { id: string } | null;
    preview: { fingerprint: string; settings: { key: string }[] };
  }>(`${RELEASES}/preview`);
  const released = await request(RELEASES, {
    method: "POST",
    body: JSON.stringify({
      settings: view.preview.settings.map((setting) => setting.key),
      head: view.head?.id ?? null,
      fingerprint: view.preview.fingerprint,
      publishTasks: true,
      publishTrials: true,
    }),
  });
  expect(released.status).toBe(201);
  expect((await released.json()).release).toMatchObject({
    tasksPublished: true,
    trialsPublished: true,
  });

  const served = (
    await json<{ group: { releaseId: string } }>("/api/public/groups/acme/python-web")
  ).group;
  expect(served).toMatchObject({ tasksPublished: true, trialsPublished: true });
  const tasks = `/api/public/releases/${served.releaseId}/tasks`;
  const listed = (
    await json<{ tasks: { id: string; repository?: string; passed?: Record<string, boolean> }[] }>(
      tasks,
    )
  ).tasks;
  // Two members' t1 and t2: each names its repository, and the second of a name is numbered.
  expect(listed.map((task) => [task.id, task.repository])).toEqual([
    ["t1", "pallets/flask"],
    ["t2", "pallets/flask"],
    ["t1~2", "django/django"],
    ["t2~2", "django/django"],
  ]);
  // A trial from the group's own run, and one from a member's own run.
  for (const task of ["t1", "t1~2"]) {
    for (const settingId of Object.keys(listed[0]?.passed ?? {})) {
      const trial = await request(`${tasks}/${task}/trials/${settingId}`);
      expect(trial.status).toBe(200);
    }
  }
});
