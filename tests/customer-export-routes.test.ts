import { afterEach, expect, test } from "bun:test";
import type { CustomerExportRequest } from "../src/customer-exports/types.js";
import { exportPrefix } from "../src/customer-exports/types.js";
import { createVault } from "../src/db/vault.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import {
  credentialedInput,
  evaluationEnv,
  evaluationServer,
} from "./support/evaluation-fixture.js";

const servers: Awaited<ReturnType<typeof evaluationServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function fixture() {
  const requests: CustomerExportRequest[] = [];
  const server = await evaluationServer(undefined, {
    exportCustomer: async (request) => {
      requests.push(request);
    },
  });
  servers.push(server);
  const vault = createVault(server.db, evaluationEnv.SELFBENCH_EVAL_CREDENTIAL_KEY);
  const input = await credentialedInput(vault, (input) => {
    input.repoId = server.repo.id;
    input.tasks = [
      {
        runId: "run",
        taskId: "frozen-task",
        bundleKey: "runs/run/verify/task/execution-hash/execution-task.tar.gz",
        images: {
          agent: `us-docker.pkg.dev/project/tasks/agent@sha256:${"a".repeat(64)}`,
          verifier: `us-docker.pkg.dev/project/tasks/verifier@sha256:${"b".repeat(64)}`,
        },
      },
    ];
  });
  const run = initialEvaluation(input, "Test Model");
  run.status = "completed";
  await saveEvaluation(server.artifacts, run);
  const body = {
    id: crypto.randomUUID(),
    customer: "Acme",
    email: "customer@example.com",
    evaluationId: input.id,
  };
  return { server, requests, input, body };
}
test("exports freeze the selected evaluation, survive repeated submission, and deliver a tenant-scoped ZIP", async () => {
  const { server, requests, input, body } = await fixture();
  const path = `${server.base}/exports`;
  const post = () => server.request(path, { method: "POST", body: JSON.stringify(body) });
  expect((await post()).status).toBe(202);
  expect(requests[0]?.tasks).toEqual(input.tasks);
  expect((await post()).status).toBe(202);
  expect(requests[1]).toEqual(requests[0]);
  const list = await (await server.request(path)).json();
  expect(list.enabled).toBe(true);
  expect(list.exports[0].status).toBe("preparing");
  expect(JSON.stringify(list)).not.toContain("bundleKey");
  expect((await server.request(`${path}/${body.id}/download`)).status).toBe(409);
  const root = exportPrefix(server.repo.id, body.id);
  await server.artifacts.put(`${root}harbor.zip`, Buffer.from("zip-bytes"), "application/zip");
  await server.artifacts.put(
    `${root}ready.json`,
    Buffer.from(JSON.stringify({ repository: "registry/project/customer" })),
    "application/json",
  );
  const download = await server.request(`${path}/${body.id}/download`);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("application/zip");
  expect(await download.text()).toBe("zip-bytes");
  expect((await server.request(`${path}/${body.id}/download`, {}, 2)).status).toBe(404);
  expect((await server.request(`${path}/${body.id}/download`, {}, null)).status).toBe(401);
  const other = path.replace("avyay/repo/", "avyay/other/");
  expect((await server.request(`${other}/${body.id}/download`)).status).toBe(404);
});
test("exports refuse untrusted requests, reused identities, unknown evaluations, and malformed bodies", async () => {
  const { server, body } = await fixture();
  const path = `${server.base}/exports`;
  expect(
    (
      await server.request(path, {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect((await server.request(path, { method: "POST", body: "not-json" })).status).toBe(400);
  expect(
    (
      await server.request(path, {
        method: "POST",
        body: JSON.stringify({ ...body, evaluationId: crypto.randomUUID() }),
      })
    ).status,
  ).toBe(400);
  expect((await server.request(path, { method: "POST", body: JSON.stringify(body) })).status).toBe(
    202,
  );
  expect(
    (
      await server.request(path, {
        method: "POST",
        body: JSON.stringify({ ...body, email: "different@example.com" }),
      })
    ).status,
  ).toBe(409);
});
