import { beforeEach, expect, test } from "bun:test";
import { type ReleaseServer, releaseServerPerTest } from "./support/release-server.js";

const suite = releaseServerPerTest(["sol", "luna"], "eval");
let server: ReleaseServer;
beforeEach(() => {
  server = suite.server;
});

test("an eval is released like a repository and listed on selfbench.dev under its name", async () => {
  const response = await server.release({ settings: await server.allSettings() });
  expect(response.status).toBe(201);
  const { release } = await response.json();
  expect(release).toMatchObject({ tasks: 3, settings: 2, current: true });

  const listed = await (await server.request("/api/public/releases", {}, null)).json();
  expect(listed.lines).toHaveLength(1);
  expect(listed.lines[0].release).toMatchObject({
    repository: { fullName: "evals/terminal" },
    publisher: { login: "acme", kind: "org" },
    tasks: 3,
  });
  // Its tasks are its own scenarios, with no public repository behind them: never published.
  expect(listed.lines[0].release.tasksPublished).toBeUndefined();
  const page = await server.request("/api/public/repos/evals/terminal", {}, null);
  expect(page.status).toBe(200);
  expect(server.changes).toEqual([{ fullName: "evals/terminal", publisher: "acme" }]);
});

test("an eval's tasks stay private", async () => {
  const { preview } = await server.preview();
  const body = {
    settings: await server.allSettings(),
    head: null,
    fingerprint: preview.fingerprint,
    publishTasks: true,
  };
  const response = await server.request(
    server.base,
    { method: "POST", body: JSON.stringify(body) },
    1,
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("tasks stay private");
  expect((await server.releases.list(server.line)).length).toBe(0);
});

test("one publisher holds an eval's name on selfbench.dev", async () => {
  // Another workspace already publishes an eval under the same name.
  await server.releases.insert({
    line: { orgId: 9999, evalRepoId: 9999 },
    fullName: "evals/terminal",
    publisherLogin: "rival",
    releasedBy: { id: 1, login: "someone" },
    hash: "rival",
    payload: {
      schemaVersion: 1,
      repository: { id: 9999, fullName: "evals/terminal" },
      publisher: { login: "rival", kind: "org" },
      tasks: 1,
      settings: [],
      frontier: [],
    },
    detail: {},
  });
  const response = await server.release({ settings: await server.allSettings() });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain("rival already publishes");
});

test("withdrawing an eval's release takes it off selfbench.dev", async () => {
  const { release } = await (await server.release({ settings: await server.allSettings() })).json();
  const withdrawn = await server.request(
    `${server.base}/${release.id}/withdraw`,
    { method: "POST", body: "{}" },
    1,
  );
  expect(withdrawn.status).toBe(200);
  const listed = await (await server.request("/api/public/releases", {}, null)).json();
  expect(listed.lines).toHaveLength(0);
});
