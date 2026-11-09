import { afterEach, expect, test } from "bun:test";
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

/** A workspace scenario task in an eval, settled with a submitted draft. */
async function taskWithDraft(accepted: boolean) {
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
  await createTaskStore(fixture.site.db).settle(task.runId, candidate.candidateId, {
    stage: accepted ? "accepted" : "rejected",
    pipelineStatus: accepted ? "accepted" : "rejected",
    ...(accepted ? { bundleKey: `runs/${task.runId}/harbor-task.tar.gz` } : {}),
  });
  const variants = (variant: object) =>
    fixture.site.request(`${EVAL}/tasks/${task.runId}/${task.taskId}/variants`, {
      method: "POST",
      headers: key,
      body: JSON.stringify({ variant }),
    });
  return { ...fixture, task, key, variants };
}

const NEXT_BUILD = "https://vercel-packages.vercel.app/next/commits/d76ff78c/next";
const VARIANT = {
  label: "Next.js PR Docs",
  packages: [{ name: "next", spec: NEXT_BUILD, directory: "apps/web" }],
  files: [{ path: "AGENTS.md", mode: "append", content: "Read node_modules/next/dist/docs/." }],
};

test("a variant reruns an accepted task's checks with only its Dockerfile changed", async () => {
  const { variants, started, artifacts, task } = await taskWithDraft(true);
  const response = await variants(VARIANT);
  expect(response.status).toBe(201);
  const variant = (await response.json()).variant as { runId: string; label: string };
  expect(variant).toMatchObject({ label: "Next.js PR Docs", state: "in_progress" });
  expect(variant.runId).not.toBe(task.runId);
  expect(started.at(-1)?.input.run.runId).toBe(variant.runId);

  const input = started.at(-1)?.input;
  expect(input?.revision).toMatchObject({ feedback: "Variant: Next.js PR Docs", verifyOnly: true });
  const staged = input?.revision?.draft.sourceBundle;
  if (!staged) throw new Error("no staged draft");
  const files = Object.fromEntries(
    (await tarEntries(Buffer.from(await artifacts.get(staged)))).map((entry) => [
      entry.path,
      entry.text,
    ]),
  );
  // Everything but the Dockerfile is the original's, byte for byte.
  for (const [path, text] of Object.entries(FILES))
    if (path !== "Dockerfile") expect(files[path]).toBe(text);
  const dockerfile = files.Dockerfile ?? "";
  expect(dockerfile.startsWith(DOCKERFILE.trimEnd())).toBe(true);
  expect(dockerfile).toContain(`cd /app/apps/web`);
  expect(dockerfile).toContain(`yarn add 'next@${NEXT_BUILD}'`);
  const encoded = Buffer.from(VARIANT.files[0]?.content ?? "").toString("base64");
  expect(dockerfile).toContain(`printf %s '${encoded}' | base64 -d >> /app/AGENTS.md`);
});

test("a variant needs an accepted task and refuses values that could escape the shell", async () => {
  const rejected = await taskWithDraft(false);
  expect((await rejected.variants(VARIANT)).status).toBe(409);
  await server?.stop();

  const { variants, started, task, key } = await taskWithDraft(true);
  const before = started.length;
  const unsafe = [
    { ...VARIANT, packages: [{ name: "next; rm -rf /", spec: "16.4.3", directory: "" }] },
    { ...VARIANT, packages: [{ name: "next", spec: "16.4.3' && curl evil", directory: "" }] },
    { ...VARIANT, files: [{ path: "../etc/passwd", mode: "replace", content: "x" }] },
    { ...VARIANT, files: [{ path: ".git/config", mode: "replace", content: "x" }] },
    { label: "Nothing", packages: [], files: [] },
  ];
  for (const variant of unsafe) expect((await variants(variant)).status).toBe(400);
  const malformed = await server?.request(`${EVAL}/tasks/${task.runId}/${task.taskId}/variants`, {
    method: "POST",
    headers: key,
    body: "{not json",
  });
  expect(await malformed?.json()).toEqual({ error: "Send the variant as JSON." });
  expect(started.length).toBe(before);
});

test("a variant lives under its task, never as a task, and runs only when picked", async () => {
  const { variants, task, key, site, started, artifacts } = await taskWithDraft(true);
  const created = await variants(VARIANT);
  expect(created.status).toBe(201);
  const variant = (await created.json()).variant as { runId: string; taskId: string };
  const candidateId = started.at(-1)?.input.candidate.candidateId ?? "";
  const path = `${EVAL}/tasks/${task.runId}/${task.taskId}`;
  const listVariants = async () =>
    (await (await site.request(`${path}/variants`, { headers: key })).json()).variants as {
      runId: string;
      state: string;
      stage: string;
      changes?: unknown;
      of: unknown;
    }[];

  // Its row is its own: the tasks list, counts, and revisions never show it.
  const listed = (await (await site.request(`${EVAL}/tasks`, { headers: key })).json()).tasks as {
    runId: string;
  }[];
  expect(listed.map((row) => row.runId)).toEqual([task.runId]);
  const counts = (
    await (await site.request("/api/orgs/mupt-ai/task-counts", { headers: key })).json()
  ).counts as Record<string, { total: number }>;
  expect(Object.values(counts).map((count) => count.total)).toEqual([1]);
  expect((await (await site.request(path, { headers: key })).json()).revisions).toEqual([]);
  expect(
    (await site.request(`${EVAL}/tasks/${variant.runId}/${variant.taskId}`, { headers: key }))
      .status,
  ).toBe(404);
  expect(await listVariants()).toMatchObject([
    {
      runId: variant.runId,
      state: "in_progress",
      changes: { packages: VARIANT.packages, files: VARIANT.files },
      of: { runId: task.runId, taskId: task.taskId },
    },
  ]);

  // Its workflow writes to its own row, through the same activities a task's uses.
  const store = createTaskStore(site.db);
  const activities = createTaskActivities({ tasks: store, artifacts });
  await activities.recordTaskProgress({
    runId: variant.runId,
    candidateId,
    progress: { candidateId, taskId: task.taskId, difficulty: "medium", status: "verifying" },
  });
  expect((await listVariants())[0]?.stage).toBe("verifying");
  // A running variant cannot be deleted.
  const early = await site.request(`${path}/variants/${variant.runId}`, {
    method: "DELETE",
    headers: key,
  });
  expect(early.status).toBe(409);
  await store.variants.settle(variant.runId, candidateId, {
    pipelineStatus: "accepted",
    stage: "accepted",
    bundleKey: `runs/${variant.runId}/harbor-task.tar.gz`,
  });
  expect((await listVariants())[0]?.state).toBe("accepted");

  // A comparison may pick it once its task is approved; it is never picked by default.
  const [row] = await store.listForRun(task.runId);
  const dataset = repositoryDataset(store, row?.repoId ?? 0);
  const options = async () => (await dataset.options()).tasks;
  expect((await options()).map((entry) => entry.runId)).toEqual([]);
  const approved = await site.request(`${path}/review`, {
    method: "PUT",
    headers: key,
    body: JSON.stringify({ decision: "approve" }),
  });
  expect(approved.status).toBe(200);
  expect(await options()).toMatchObject([
    { runId: task.runId },
    { runId: variant.runId, variant: { label: "Next.js PR Docs", of: { runId: task.runId } } },
  ]);
  expect((await dataset.select()).map((picked) => picked.runId)).toEqual([task.runId]);
  expect(await dataset.select([variant])).toMatchObject([
    {
      runId: variant.runId,
      taskId: task.taskId,
      bundleKey: `runs/${variant.runId}/harbor-task.tar.gz`,
    },
  ]);
  expect((await dataset.summaryTasks()).map((counted) => counted.runId)).toEqual([task.runId]);

  const deleted = await site.request(`${path}/variants/${variant.runId}`, {
    method: "DELETE",
    headers: key,
  });
  expect(deleted.status).toBe(200);
  expect(await listVariants()).toEqual([]);
  expect((await options()).map((entry) => entry.runId)).toEqual([task.runId]);
});
