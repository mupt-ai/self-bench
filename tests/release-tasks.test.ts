import { beforeEach, expect, test } from "bun:test";
import { type ReleaseServer, releaseServerPerTest } from "./support/release-server.js";

const suite = releaseServerPerTest(["sol", "terra", "luna"]);
let server: ReleaseServer;
beforeEach(() => {
  server = suite.server;
});

/** Releases `settings` on the current preview, publishing the tasks (and trials) or not. */
async function releaseWith(settings: string[], publishTasks?: boolean, publishTrials?: boolean) {
  const view = await server.preview();
  return server.request(server.base, {
    method: "POST",
    body: JSON.stringify({
      settings,
      head: view.head?.id ?? null,
      fingerprint: view.preview.fingerprint,
      ...(publishTasks === undefined ? {} : { publishTasks }),
      ...(publishTrials === undefined ? {} : { publishTrials }),
    }),
  });
}

test("a release that publishes its tasks serves them; one that does not takes them down", async () => {
  const settings = await server.allSettings();
  const first = await releaseWith(settings);
  const quiet = (await first.json()).release;
  expect(quiet.tasksPublished).toBe(false);
  expect((await server.request(`/api/public/releases/${quiet.id}/tasks`, {}, null)).status).toBe(
    404,
  );

  // The same results with the tasks published: a new release, which the dialog then starts from.
  const published = await releaseWith(settings, true);
  expect(published.status).toBe(201);
  const release = (await published.json()).release;
  expect(release.tasksPublished).toBe(true);
  expect((await server.preview()).current.tasksPublished).toBe(true);
  const listed = await server.request(`/api/public/releases/${release.id}/tasks`, {}, null);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("x-robots-tag")).toBe("noindex");
  const { tasks } = await listed.json();
  expect(tasks).toEqual([
    { id: "t1", difficulty: "medium" },
    { id: "t2", difficulty: "medium" },
    { id: "t3", difficulty: "medium" },
  ]);
  const files = await (
    await server.request(`/api/public/releases/${release.id}/tasks/t2`, {}, null)
  ).json();
  expect(files.files.find((file: { path: string }) => file.path === "instruction.md").text).toBe(
    "Do t2.\n",
  );
  const download = await server.request(
    `/api/public/releases/${release.id}/tasks/t2/t2.tar.gz`,
    {},
    null,
  );
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toBe('attachment; filename="t2.tar.gz"');

  // Released again without them: the public page no longer serves the tasks.
  const after = await releaseWith(settings, false);
  expect(after.status).toBe(201);
  const latest = (await after.json()).release;
  expect((await server.request(`/api/public/releases/${latest.id}/tasks`, {}, null)).status).toBe(
    404,
  );
  expect((await server.request(`/api/public/releases/${release.id}/tasks`, {}, null)).status).toBe(
    404,
  );
});

test("a release that publishes its trials serves each one from its run", async () => {
  const settings = await server.allSettings();
  const release = (await (await releaseWith(settings, true, true)).json()).release;
  expect(release.trialsPublished).toBe(true);
  const { tasks } = await (
    await server.request(`/api/public/releases/${release.id}/tasks`, {}, null)
  ).json();
  const passed: Record<string, boolean> = tasks[0].passed;
  expect(Object.keys(passed)).toHaveLength(settings.length);
  const [settingId = ""] = Object.keys(passed);
  const trial = await server.request(
    `/api/public/releases/${release.id}/tasks/${tasks[0].id}/trials/${encodeURIComponent(settingId)}`,
    {},
    null,
  );
  expect(trial.status).toBe(200);
  expect(await trial.json()).toMatchObject({ taskId: tasks[0].id, settingId, steps: [] });
});
