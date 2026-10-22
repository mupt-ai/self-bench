import { afterEach, expect, test } from "bun:test";
import { createTaskStore } from "../../src/db/tasks.js";
import { prFixture, pullRequest, REPO } from "../support/pr-fixture.js";
import type { AuthServer } from "../support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot() {
  const result = await prFixture({ pullRequests: { 57: pullRequest(57) } });
  server = result.site;
  return result;
}

test("feedback starts a separate task from the submitted draft and records its lineage", async () => {
  const { site, headers, started, artifacts } = await boot();
  const originalResponse = await site.request(`${REPO}/tasks/from-pr`, {
    method: "POST",
    headers,
    body: JSON.stringify({ pr: 57 }),
  });
  expect(originalResponse.status).toBe(201);
  const original = (await originalResponse.json()).task as {
    runId: string;
    taskId: string;
    candidateId: string;
  };
  const store = createTaskStore(site.db);
  const originalRow = await store.find(1, original.runId, original.taskId);
  if (!originalRow) throw new Error("Missing original task");
  const definition = {
    schemaVersion: 2,
    taskId: "fix-pr-57",
    baseCommit: "b".repeat(40),
    prompt: "Fix the feature",
  };
  const originalRun = started[0]?.input.run.runId;
  if (!originalRun) throw new Error("Missing original run");
  const source = await artifacts.put(
    `runs/${originalRun}/authoring/${original.candidateId}/round-1/source-task.tar.gz`,
    Buffer.from("submitted source draft"),
    "application/gzip",
  );
  const definitionRef = await artifacts.put(
    `runs/${originalRun}/authoring/${original.candidateId}/round-1/definition.json`,
    Buffer.from(JSON.stringify(definition)),
    "application/json",
  );
  await artifacts.put(
    `runs/${originalRun}/authoring/${original.candidateId}/round-1/result.json`,
    Buffer.from(
      JSON.stringify({
        kind: "submitted",
        candidateId: original.candidateId,
        task: {
          candidateId: original.candidateId,
          taskId: definition.taskId,
          definition: definitionRef,
          sourceBundle: source,
        },
        session: {
          uri: "file:///session",
          sha256: "a".repeat(64),
          sizeBytes: 1,
          contentType: "text/plain",
        },
      }),
    ),
    "application/json",
  );
  await store.progress(originalRow.id, {
    stage: "accepted",
    pipelineStatus: "accepted",
    taskId: definition.taskId,
  });
  // Batch candidates have different ids, but still share a PR-derived run id namespace.
  await store.upsertMany([
    {
      repoId: originalRow.repoId,
      runId: original.runId,
      candidateId: "w1s0-another-task",
      taskId: "another-task",
      difficulty: "easy",
      pipelineStatus: "accepted",
      stage: "accepted",
    },
  ]);

  const response = await site.request(
    `${REPO}/tasks/${original.runId}/${definition.taskId}/feedback`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        feedback: "The instruction does not define the exact error wording.",
      }),
    },
  );
  expect(response.status).toBe(201);
  const revision = (await response.json()).task as { runId: string; taskId: string; state: string };
  expect(revision.runId).not.toBe(original.runId);
  expect(revision.state).toBe("in_progress");
  expect(started).toHaveLength(2);
  expect(started[1]?.input.revision?.feedback).toBe(
    "The instruction does not define the exact error wording.",
  );
  expect(started[1]?.input.revision?.draft.taskId).toBe(definition.taskId);
  expect(started[1]?.input.revision?.draft.sourceBundle.uri).toContain(revision.runId);
  const revisionRow = await store.find(1, revision.runId, revision.taskId);
  expect(revisionRow).toMatchObject({
    revisedFrom: { runId: original.runId, taskId: definition.taskId },
    feedback: "The instruction does not define the exact error wording.",
  });

  const detail = await site.request(`${REPO}/tasks/${original.runId}/${definition.taskId}`, {
    headers,
  });
  expect(await detail.json()).toMatchObject({ revisions: [{ runId: revision.runId }] });

  // A staged revision draft remains revisable even before its agent submits a round result.
  if (!revisionRow) throw new Error("Missing revision task");
  await store.progress(revisionRow.id, { stage: "rejected", pipelineStatus: "rejected" });
  const retry = await site.request(`${REPO}/tasks/${revision.runId}/${revision.taskId}/feedback`, {
    method: "POST",
    headers,
    body: JSON.stringify({ feedback: "Also make the requested behavior explicit." }),
  });
  expect(retry.status).toBe(201);
  expect(started).toHaveLength(3);
  const retried = (await retry.json()).task as { runId: string };
  expect(retried.runId).not.toBe(revision.runId);
});

test("feedback refuses active tasks, missing drafts, and empty feedback", async () => {
  const { site, headers, started } = await boot();
  const created = await site.request(`${REPO}/tasks/from-pr`, {
    method: "POST",
    headers,
    body: JSON.stringify({ pr: 57 }),
  });
  const task = (await created.json()).task as { runId: string; taskId: string };
  const path = `${REPO}/tasks/${task.runId}/${task.taskId}/feedback`;
  const post = (feedback: string) =>
    site.request(path, { method: "POST", headers, body: JSON.stringify({ feedback }) });
  expect((await post("Please improve it")).status).toBe(409);
  const store = createTaskStore(site.db);
  const row = await store.find(1, task.runId, task.taskId);
  if (!row) throw new Error("Missing task");
  await store.progress(row.id, { stage: "rejected", pipelineStatus: "rejected" });
  expect((await post(" ")).status).toBe(400);
  expect((await post("Please improve it")).status).toBe(409);
  expect(started).toHaveLength(1);
});
