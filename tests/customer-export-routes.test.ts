import { afterEach, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { createRegistryGrantStore } from "../src/db/registry-grants.js";
import { createVault } from "../src/db/vault.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import {
  credentialedInput,
  evaluationEnv,
  evaluationServer,
} from "./support/evaluation-fixture.js";
import { gzippedTar } from "./support/tar.js";

const repository = "us-docker.pkg.dev/project/tasks";
const agent = `${repository}/agent@sha256:${"a".repeat(64)}`;
const verifier = `${repository}/verifier@sha256:${"b".repeat(64)}`;
const bundleKey = "runs/run/verify/task/execution-hash/execution-task.tar.gz";
const imageTask = (taskId: string): EvaluationInput["tasks"][number] => ({
  runId: "run",
  taskId,
  bundleKey,
  images: { agent, verifier },
});

const servers: Awaited<ReturnType<typeof evaluationServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
/** A server whose exports use a real grant store on its own database. */
async function exportServer() {
  let grants: ReturnType<typeof createRegistryGrantStore> | undefined;
  const server = await evaluationServer(undefined, {
    customerExports: {
      repository,
      grants: {
        createForImages: (input) => store().createForImages(input),
        find: (id) => store().find(id),
        revoke: (id) => store().revoke(id),
      },
    },
  });
  servers.push(server);
  const store = () => {
    grants ??= createRegistryGrantStore(server.db, "registry-secret", repository);
    return grants;
  };
  return { server, store };
}
async function fixture() {
  const { server, store } = await exportServer();
  await server.artifacts.put(
    bundleKey,
    await gzippedTar({
      "harbor-task/instruction.md": "Fix the task.",
      "harbor-task/task.toml": '[verifier]\nenvironment_mode = "separate"\n',
      "harbor-task/environment/Dockerfile": `FROM ${agent}\n`,
      "harbor-task/tests/Dockerfile": `FROM ${verifier}\n`,
      "harbor-task/tests/test.sh": "#!/bin/bash\ntrue\n",
      "harbor-task/tests/test.patch": "hidden tests",
      "harbor-task/solution/solve.sh": "#!/bin/bash\ntrue\n",
      "harbor-task/solution/gold.patch": "reference patch",
    }),
    "application/gzip",
  );
  const vault = createVault(server.db, evaluationEnv.SELFBENCH_EVAL_CREDENTIAL_KEY);
  const evaluate = async (
    tasks: EvaluationInput["tasks"],
    createdAt = new Date().toISOString(),
  ) => {
    const input = await credentialedInput(vault, (next) => {
      next.repoId = server.repo.id;
      next.createdAt = createdAt;
      next.tasks = tasks;
    });
    const run = initialEvaluation(input, "Test Model");
    run.status = "completed";
    await saveEvaluation(server.artifacts, run);
    return input;
  };
  const input = await evaluate([imageTask("frozen-task")]);
  const body = { id: crypto.randomUUID(), customer: "Acme" };
  const path = `${server.base}/exports`;
  const post = (payload: unknown = body) =>
    server.request(path, { method: "POST", body: JSON.stringify(payload) });
  return { server, input, body, path, post, evaluate, store };
}

test("an export issues a grant for the evaluation's images and a ZIP that pulls through SelfBench", async () => {
  const { server, input, body, path, post, store } = await fixture();
  const created = await post();
  expect(created.status).toBe(201);
  const state = await created.json();
  expect(state).toMatchObject({ id: body.id, evaluationId: input.id, status: "ready" });
  const zip = await server.request(`${path}/${body.id}/download`);
  expect(zip.status).toBe(200);
  const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const readme = strFromU8(files["README.md"] ?? new Uint8Array());
  const password = /echo '([^']+)' \| docker login/.exec(readme)?.[1] ?? "";
  // The ZIP's key reaches exactly the export's two images, and nothing else.
  const grant = await store().resolve(password);
  expect([...(grant?.images ?? [])].sort()).toEqual([
    `agent@sha256:${"a".repeat(64)}`,
    `verifier@sha256:${"b".repeat(64)}`,
  ]);
  // Images are pulled from the same SelfBench host the README signs Docker in to.
  const host = /docker login (\S+) /.exec(readme)?.[1];
  expect(host).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(strFromU8(files["tasks/task-0001/environment/Dockerfile"] ?? new Uint8Array())).toBe(
    `FROM ${host}/agent@sha256:${"a".repeat(64)}\n`,
  );
  // Repeating the request returns the same export instead of issuing a second key.
  expect((await post()).status).toBe(200);
  const list = await (await server.request(path)).json();
  expect(list.enabled).toBe(true);
  expect(list.exports).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain("bundleKey");
  expect(JSON.stringify(list)).not.toContain(password);
});
test("concurrent requests for one export share a single key", async () => {
  const { server, body, path, post, store } = await fixture();
  const statuses = (await Promise.all([post(), post(), post()])).map((r) => r.status);
  // One request writes the export; the others see it finished or still being created.
  expect(statuses.filter((status) => status === 201)).toHaveLength(1);
  expect(statuses.every((status) => [200, 201, 409].includes(status))).toBe(true);
  expect(await store().list()).toHaveLength(1);
  expect((await server.request(`${path}/${body.id}/download`)).status).toBe(200);
});
test("a failed write revokes the key the request issued", async () => {
  const { server, body, post, store } = await fixture();
  const put = server.artifacts.put.bind(server.artifacts);
  server.artifacts.put = async (key, ...rest) => {
    if (key.endsWith("/harbor.zip")) throw new Error("storage unavailable");
    return await put(key, ...rest);
  };
  expect((await post()).status).toBeGreaterThanOrEqual(500);
  server.artifacts.put = put;
  const [grant] = await store().list();
  expect(grant?.id).toBe(body.id);
  expect(grant?.revokedAt).not.toBeNull();
  // The revoked key cannot be reused, so the same id is refused rather than silently reissued.
  expect((await post()).status).toBe(409);
});
test("revoking an export stops its key at once", async () => {
  const { server, body, path, post, store } = await fixture();
  await post();
  const files = unzipSync(
    new Uint8Array(await (await server.request(`${path}/${body.id}/download`)).arrayBuffer()),
  );
  const password =
    /echo '([^']+)' \| docker login/.exec(strFromU8(files["README.md"] ?? new Uint8Array()))?.[1] ??
    "";
  const revoked = await server.request(`${path}/${body.id}/revoke`, { method: "POST" });
  expect(revoked.status).toBe(200);
  expect((await revoked.json()).status).toBe("revoked");
  expect(await store().resolve(password)).toBeUndefined();
});
test("exports skip newer evaluations that are not image-backed or are over the task limit", async () => {
  const { input, post, evaluate } = await fixture();
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  await evaluate(
    [{ runId: "run", taskId: "legacy", bundleKey: "runs/run/legacy/task.tar.gz" }],
    later(1),
  );
  await evaluate(
    Array.from({ length: 501 }, (_, index) => imageTask(`task-${index}`)),
    later(2),
  );
  const created = await post();
  expect(created.status).toBe(201);
  expect((await created.json()).evaluationId).toBe(input.id);
});
test("exports refuse when no completed evaluation is image-backed", async () => {
  const { server } = await exportServer();
  const response = await server.request(`${server.base}/exports`, {
    method: "POST",
    body: JSON.stringify({ id: crypto.randomUUID(), customer: "Acme" }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("No completed evaluation");
});
test("exports refuse untrusted requests, reused identities, and malformed bodies", async () => {
  const { server, body, path, post } = await fixture();
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
  expect((await post({ ...body, email: "customer@example.com" })).status).toBe(400);
  expect((await post()).status).toBe(201);
  expect((await post({ ...body, customer: "Other" })).status).toBe(409);
  expect((await server.request(`${path}/${body.id}/download`, {}, 2)).status).toBe(404);
  expect((await server.request(`${path}/${body.id}/download`, {}, null)).status).toBe(401);
});
