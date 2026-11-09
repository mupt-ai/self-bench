import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ScenarioCandidate } from "../../src/contracts/index.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { repositoryDataset } from "../../src/evaluation/dataset.js";
import { createTaskActivities } from "../../src/generation/tasks/activities.js";
import { mint } from "../support/api-keys.js";
import { prFixture } from "../support/pr-fixture.js";
import type { AuthServer } from "../support/site-fixture.js";
import { gzippedTar, tarEntries } from "../support/tar.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const EVAL = "/api/orgs/mupt-ai/repos/evals/data-import-bugs";
const DOCKERFILE = "FROM node:22-bookworm\nADD repo.tar.gz /app/\nRUN cd /app && npm ci\n";
const FILES = {
  "instruction.md": "Fix the CSV import so every row imports.",
  Dockerfile: DOCKERFILE,
  "test.patch": "diff --git a/tests/import.test.ts b/tests/import.test.ts\n",
  "gold.patch": "diff --git a/src/import.ts b/src/import.ts\n",
  "workspace/package.json": "{}",
};

/** A workspace scenario task in an eval with a submitted draft, approved unless `approved` is false. */
async function evalWithTask(approved = true) {
  const fixture = await prFixture({});
  server = fixture.site;
  const { secret } = await mint(fixture.site, fixture.headers, { name: "CLI" });
  const key = { authorization: `Bearer ${secret}` };
  await fixture.site.request("/api/orgs/mupt-ai/evals", {
    method: "POST",
    headers: fixture.headers,
    body: JSON.stringify({ name: "Data Import Bugs" }),
  });
  const created = await fixture.site.request(`${EVAL}/tasks/from-scenario`, {
    method: "POST",
    headers: key,
    body: JSON.stringify({ title: "CSV Import", scenario: "Rows with quoted commas are lost." }),
  });
  const task = (await created.json()).task as { runId: string; taskId: string };
  const candidate = fixture.started[0]?.input.candidate as ScenarioCandidate;
  const source = await fixture.artifacts.put(
    `runs/${task.runId}/authoring/${candidate.candidateId}/round-1/source-task.tar.gz`,
    await gzippedTar(FILES),
    "application/gzip",
  );
  await fixture.artifacts.put(
    `runs/${task.runId}/authoring/${candidate.candidateId}/round-1/result.json`,
    Buffer.from(
      JSON.stringify({
        kind: "submitted",
        task: { candidateId: candidate.candidateId, taskId: task.taskId, sourceBundle: source },
      }),
    ),
    "application/json",
  );
  const store = createTaskStore(fixture.site.db);
  await store.settle(task.runId, candidate.candidateId, {
    stage: "accepted",
    pipelineStatus: "accepted",
    bundleKey: `runs/${task.runId}/harbor-task.tar.gz`,
  });
  if (approved)
    await fixture.site.request(`${EVAL}/tasks/${task.runId}/${task.taskId}/review`, {
      method: "PUT",
      headers: key,
      body: JSON.stringify({ decision: "approve" }),
    });
  const [row] = await store.listForRun(task.runId);
  const environments = (body: object, path = "") =>
    fixture.site.request(`${EVAL}/environments${path}`, {
      method: "POST",
      headers: key,
      body: JSON.stringify(body),
    });
  return { ...fixture, task, key, store, repoId: row?.repoId ?? 0, environments };
}

const NEXT_BUILD = "https://vercel-packages.vercel.app/next/commits/d76ff78c/next";
const ENVIRONMENT = {
  name: "Next.js PR Build, No AGENTS.md",
  packages: [{ name: "next", spec: NEXT_BUILD, directory: "apps/web" }],
  files: [
    { path: "CLAUDE.md", mode: "append", content: "Read node_modules/next/dist/docs/." },
    { path: "AGENTS.md", mode: "delete" },
  ],
};

test("an environment builds every approved task with only its Dockerfile changed", async () => {
  const { environments, started, artifacts, task } = await evalWithTask();
  const response = await environments({ environment: ENVIRONMENT });
  expect(response.status).toBe(201);
  const created = (await response.json()).environment as { id: number; tasks: unknown };
  expect(created.tasks).toEqual({ ready: 0, checking: 1, failed: 0, total: 1 });

  const input = started.at(-1)?.input;
  expect(input?.revision).toMatchObject({ verifyOnly: true });
  expect(input?.run.runId).not.toBe(task.runId);
  const staged = input?.revision?.draft.sourceBundle;
  if (!staged) throw new Error("no staged draft");
  const files = Object.fromEntries(
    (await tarEntries(Buffer.from(await artifacts.get(staged)))).map((entry) => [
      entry.path,
      entry.text,
    ]),
  );
  // Everything but the Dockerfile is the task's own, byte for byte.
  for (const [path, text] of Object.entries(FILES))
    if (path !== "Dockerfile") expect(files[path]).toBe(text);
  const dockerfile = files.Dockerfile ?? "";
  expect(dockerfile.startsWith(DOCKERFILE.trimEnd())).toBe(true);
  expect(dockerfile).toContain(`cd /app/apps/web`);
  expect(dockerfile).toContain(`yarn add 'next@${NEXT_BUILD}'`);
  const encoded = Buffer.from(ENVIRONMENT.files[0]?.content ?? "").toString("base64");
  expect(dockerfile).toContain(`printf %s '${encoded}' | base64 -d >> /app/CLAUDE.md`);
  expect(dockerfile).toContain("RUN rm -rf -- /app/AGENTS.md");
});

test("an environment needs an approved task and refuses values that could escape the shell", async () => {
  const unapproved = await evalWithTask(false);
  expect((await unapproved.environments({ environment: ENVIRONMENT })).status).toBe(409);
  await server?.stop();

  const { environments, started, key } = await evalWithTask();
  const before = started.length;
  const unsafe = [
    { ...ENVIRONMENT, packages: [{ name: "next; rm -rf /", spec: "16.4.3", directory: "" }] },
    { ...ENVIRONMENT, packages: [{ name: "next", spec: "16.4.3' && curl evil", directory: "" }] },
    { ...ENVIRONMENT, files: [{ path: "../etc/passwd", mode: "delete" }] },
    { ...ENVIRONMENT, files: [{ path: ".git", mode: "delete" }] },
    { name: "Nothing", packages: [], files: [] },
  ];
  for (const environment of unsafe) expect((await environments({ environment })).status).toBe(400);
  const malformed = await server?.request(`${EVAL}/environments`, {
    method: "POST",
    headers: key,
    body: "{not json",
  });
  expect(await malformed?.json()).toEqual({ error: "Send the environment as JSON." });
  expect(started.length).toBe(before);
});

test("an environment is never a task, and a condition runs its tasks as their own", async () => {
  const { environments, task, key, site, started, artifacts, store, repoId, cancelled } =
    await evalWithTask();
  const created = (await (await environments({ environment: ENVIRONMENT })).json()).environment as {
    id: number;
  };
  const variant = started.at(-1)?.input;
  const variantRun = variant?.run.runId ?? "";
  const candidateId = variant?.candidate.candidateId ?? "";
  const list = async () =>
    (await (await site.request(`${EVAL}/environments`, { headers: key })).json()).environments as {
      id: number;
      tasks: { ready: number; checking: number };
    }[];

  // Its variants are not tasks: the task list and counts still hold the one task.
  const tasks = (await (await site.request(`${EVAL}/tasks`, { headers: key })).json()).tasks as {
    runId: string;
  }[];
  expect(tasks.map((row) => row.runId)).toEqual([task.runId]);
  const counts = (
    await (await site.request("/api/orgs/mupt-ai/task-counts", { headers: key })).json()
  ).counts as Record<string, { total: number }>;
  expect(Object.values(counts).map((count) => count.total)).toEqual([1]);

  // Its variant's workflow writes to its own row, through the same activities a task's uses.
  const activities = createTaskActivities({ tasks: store, artifacts });
  await activities.recordTaskProgress({
    runId: variantRun,
    candidateId,
    progress: { candidateId, taskId: task.taskId, difficulty: "medium", status: "verifying" },
  });
  const dataset = repositoryDataset(store, repoId);
  const picked = await dataset.select();
  expect((await dataset.environment?.(created.id, picked))?.tasks).toEqual([]);
  await store.variants.settle(variantRun, candidateId, {
    pipelineStatus: "accepted",
    stage: "accepted",
    bundleKey: `runs/${variantRun}/harbor-task.tar.gz`,
  });
  expect((await list())[0]?.tasks).toMatchObject({ ready: 1, checking: 0 });

  // A condition runs the task from its variant's bundle, under the task's own key.
  expect(await dataset.environment?.(created.id, picked)).toEqual({
    name: ENVIRONMENT.name,
    tasks: [
      expect.objectContaining({
        runId: task.runId,
        taskId: task.taskId,
        bundleKey: `runs/${variantRun}/harbor-task.tar.gz`,
      }),
    ],
  });
  const detail = await (
    await site.request(`${EVAL}/environments/${created.id}`, { headers: key })
  ).json();
  expect(detail.tasks).toEqual([
    { task: { runId: task.runId, taskId: task.taskId }, runId: variantRun, state: "accepted" },
  ]);

  // Building again starts nothing while every task is ready; deleting removes it.
  expect(cancelled).toEqual([]);
  expect((await environments({}, `/${created.id}/build`)).status).toBe(409);
  const deleted = await site.request(`${EVAL}/environments/${created.id}`, {
    method: "DELETE",
    headers: key,
  });
  expect(deleted.status).toBe(200);
  expect(await list()).toEqual([]);
  expect(await dataset.environment?.(created.id, picked)).toBeUndefined();
});

test("deleting an environment or a task stops its checks, and says when one did not", async () => {
  const { environments, task, key, site, started, cancelled, stuck, store, repoId } =
    await evalWithTask();
  const first = (await (await environments({ environment: ENVIRONMENT })).json()).environment as {
    id: number;
  };
  const firstCheck = started.at(-1)?.workflowId ?? "";
  // A check that will not stop is reported, and deleting again retries it.
  stuck.add(firstCheck);
  const remove = () =>
    site.request(`${EVAL}/environments/${first.id}`, { method: "DELETE", headers: key });
  const failed = await remove();
  expect(failed.status).toBe(502);
  expect((await failed.json()).error).toBe(
    "Deleted, but 1 running check did not stop. Delete it again to retry.",
  );
  stuck.delete(firstCheck);
  expect((await remove()).status).toBe(200);
  expect(cancelled).toEqual([firstCheck]);
  // A deleted environment starts no more checks.
  const [row] = await store.listForRun(task.runId);
  await expect(
    store.variants.reserve({
      environmentId: first.id,
      parentId: row?.id ?? 0,
      repoId,
      runId: "late",
      candidateId: "late",
      taskId: task.taskId,
      startedBy: 1,
    }),
  ).rejects.toThrow("The environment or its task was deleted.");

  await environments({ environment: { ...ENVIRONMENT, name: "Again" } });
  const secondCheck = started.at(-1)?.workflowId ?? "";
  await site.request(`${EVAL}/tasks/${task.runId}/${task.taskId}`, {
    method: "DELETE",
    headers: key,
  });
  expect(cancelled).toContain(secondCheck);
});

test("deleting a task deletes its variants, so no environment runs it", async () => {
  const { environments, task, key, site, started, store, repoId } = await evalWithTask();
  const created = (await (await environments({ environment: ENVIRONMENT })).json()).environment as {
    id: number;
  };
  const variant = started.at(-1)?.input;
  await store.variants.settle(variant?.run.runId ?? "", variant?.candidate.candidateId ?? "", {
    pipelineStatus: "accepted",
    stage: "accepted",
    bundleKey: "runs/variant/harbor-task.tar.gz",
  });
  const path = `${EVAL}/tasks/${task.runId}/${task.taskId}`;
  expect((await site.request(path, { method: "DELETE", headers: key })).status).toBe(200);
  expect(await store.variants.listForRepo(repoId)).toEqual([]);
  const listed = (await (await site.request(`${EVAL}/environments`, { headers: key })).json())
    .environments as { id: number; tasks: { total: number } }[];
  expect(listed.map((environment) => [environment.id, environment.tasks.total])).toEqual([
    [created.id, 0],
  ]);
});

test("a build that cannot start is settled as failed and reported, so it can be built again", async () => {
  const { environments, task, store, repoId, artifacts, started } = await evalWithTask();
  const candidateId = started[0]?.input.candidate.candidateId ?? "";
  const source = await artifacts.stat(
    `runs/${task.runId}/authoring/${candidateId}/round-1/source-task.tar.gz`,
  );
  if (!source) throw new Error("no source bundle");
  // The task's draft can no longer be unpacked, so staging its variant throws after the reserve.
  await writeFile(fileURLToPath(source.uri), "not a tarball");
  const response = await environments({ environment: ENVIRONMENT });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { failures?: string[]; environment: { tasks: unknown } };
  expect(body.failures).toEqual([expect.stringContaining(`${task.taskId}: `)]);
  expect(body.environment.tasks).toEqual({ ready: 0, checking: 0, failed: 1, total: 1 });
  const [variant] = await store.variants.listForRepo(repoId);
  expect(variant).toMatchObject({ pipelineStatus: "infrastructure_failed" });
  expect(variant?.reason).toStartWith("The check could not start:");
});
