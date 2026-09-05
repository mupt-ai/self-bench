import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import {
  type AuthServer,
  cookieValue,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "./support/site-fixture.js";
import { archive, harborFiles } from "./support/upload-fixture.js";

let server: AuthServer | undefined;
let directory: string;
afterEach(async () => {
  await server?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const REPO = "/api/orgs/avyay/repos/avyay/project";
async function setup() {
  directory = await mkdtemp(join(tmpdir(), "upload-test-"));
  const store = new LocalArtifactStore(directory);
  server = await startAuthServer({
    config: testAuthConfig,
    artifacts: store,
    fetchImpl: fakeGitHub({ repos: [{ full_name: "avyay/project" }, { full_name: "avyay/other" }] })
      .fetch,
  });
  const start = await server.request("/auth/github");
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const callback = await server.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  });
  const cookie = `${SESSION_COOKIE}=${cookieValue(callback, SESSION_COOKIE)}`;
  for (const fullName of ["avyay/project", "avyay/other"])
    await server.request("/api/orgs/avyay/repos", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ fullName }),
    });
  const headers = { cookie, "content-type": "application/octet-stream" };
  const site = server;
  const post = (action: string, body: Buffer, receipt?: string, repo = REPO) =>
    site.request(`${repo}/uploads/${action}`, {
      method: "POST",
      headers: { ...headers, ...(receipt ? { "x-upload-preview": receipt } : {}) },
      body: new Uint8Array(body),
    });
  return { site, headers, post, store };
}
test("authenticated tenant scoped validate/import; no execution; review and duplicates", async () => {
  const { site, headers, post, store } = await setup();
  const body = await archive(harborFiles());
  expect(
    (await site.request(`${REPO}/uploads/preview`, { method: "POST", body: new Uint8Array(body) }))
      .status,
  ).toBe(401);
  expect(
    (await post("preview", body, undefined, REPO.replace("orgs/avyay", "orgs/unknown"))).status,
  ).toBe(404);
  expect((await post("import", body)).status).toBe(400);
  const preview = await (await post("preview", body)).json();
  expect(preview.tasks[0].errors).toEqual([]);
  expect((await store.list("tenants")).length).toBe(0);
  expect(
    (await post("import", body, preview.receipt, REPO.replace("project", "other"))).status,
  ).toBe(400);
  expect((await post("import", await archive(harborFiles("beta/")), preview.receipt)).status).toBe(
    400,
  );
  const imported = await post("import", body, preview.receipt);
  expect(imported.status).toBe(201);
  const { runId } = await imported.json();
  let task = (await (await site.request(`${REPO}/tasks`, { headers })).json()).tasks[0];
  expect(task).toMatchObject({ pipelineStatus: "uploaded", state: "uploaded", stage: "uploaded" });
  expect((await store.list("runs")).length).toBe(0);
  const bundlePath = `${REPO}/uploads/${runId}/alpha/bundle`;
  const bundle = await (await site.request(bundlePath, { headers })).json();
  expect(
    bundle.files.find((file: { path: string }) => file.path === "tests/test.sh").text,
  ).toContain("NEVER_EXECUTE_UPLOAD");
  expect((await site.request(bundlePath.replace("project", "other"), { headers })).status).toBe(
    404,
  );
  const approved = await site.request(`${REPO}/tasks/${runId}/alpha/review`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  task = (await approved.json()).task;
  expect(task).toMatchObject({ state: "accepted", pipelineStatus: "uploaded" });
  expect((await post("import", body, preview.receipt)).status).toBe(409);
  expect((await (await post("preview", body)).json()).tasks[0].conflicts.length).toBeGreaterThan(0);
  expect((await (await site.request(`${REPO}/runs`, { headers })).json()).runs).toEqual([]);
});
test("mixed malformed upload imports only previewed eligible tasks; rejects bad types and files", async () => {
  const { site, headers, post } = await setup();
  expect((await post("preview", Buffer.from("not tar"))).status).toBe(400);
  expect(
    (
      await site.request(`${REPO}/uploads/preview`, {
        method: "POST",
        headers: { ...headers, "content-type": "text/plain" },
        body: "x",
      })
    ).status,
  ).toBe(415);
  const body = await archive([...harborFiles(), { name: "broken/task.toml", text: "garbage" }]);
  const preview = await (await post("preview", body)).json();
  expect(preview.tasks[1].errors.length).toBeGreaterThan(0);
  expect(await (await post("import", body, preview.receipt)).json()).toMatchObject({ imported: 1 });
});
