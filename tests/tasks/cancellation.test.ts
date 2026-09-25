import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { repos } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/tasks.js";
import type { TaskStatusSource } from "../../src/generation/tasks/status.js";
import { connectRepo, signedIn } from "../support/sign-in.js";
import {
  type AuthServer,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "../support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";

test("task cancellation is tenant-scoped, race-safe, and idempotent after confirmation", async () => {
  let cancellationRequested = false;
  let cancelCalls = 0;
  const status: TaskStatusSource = {
    snapshot: async () =>
      cancellationRequested
        ? { kind: "cancelled" }
        : {
            kind: "running",
            progress: {
              candidateId: "active",
              taskId: "task-active",
              difficulty: "medium",
              status: "authoring",
            },
          },
    cancel: async () => {
      cancelCalls += 1;
      cancellationRequested = true;
    },
  };
  const artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "task-cancel-")));
  const hub = fakeGitHub({ orgs: ["Mupt-AI"], repos: [{ full_name: "Mupt-AI/self-bench" }] });
  server = await startAuthServer({
    config: testAuthConfig,
    artifacts,
    fetchImpl: hub.fetch,
    status,
  });
  const headers = await signedIn(server);
  await connectRepo(server, headers);
  const [repo] = await server.db
    .select()
    .from(repos)
    .where(eq(repos.fullName, "Mupt-AI/self-bench"));
  if (!repo) throw new Error("missing connected repository");
  await createTaskStore(server.db).insertStarted({
    repoId: repo.id,
    runId: "run-active",
    candidateId: "active",
    taskId: "task-active",
    difficulty: "medium",
    pipelineStatus: "in_progress",
    stage: "authoring",
    workflowId: "run-active/candidate/active",
    startedBy: 1,
  });

  const denied = await server.request(
    "/api/orgs/not-a-tenant/repos/Mupt-AI/self-bench/tasks/run-active/active/cancel",
    { method: "POST", headers },
  );
  expect(denied.status).toBe(404);
  expect(cancelCalls).toBe(0);

  const requested = await server.request(`${REPO}/tasks/run-active/active/cancel`, {
    method: "POST",
    headers,
  });
  expect(requested.status).toBe(202);
  expect(await requested.json()).toEqual({ state: "requested" });
  expect(cancelCalls).toBe(1);

  const detail = await server.request(`${REPO}/tasks/run-active/active`, { headers });
  expect(await detail.json()).toMatchObject({ task: { state: "cancelled" } });
  const repeated = await server.request(`${REPO}/tasks/run-active/active/cancel`, {
    method: "POST",
    headers,
  });
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual({ state: "confirmed" });
  expect(cancelCalls).toBe(1);
});
