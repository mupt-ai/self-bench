import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendApiError, sendJson } from "../../src/api/http.js";
import { createBatchRoutes } from "../../src/api/routes/batches.js";
import { createTaskRoutes } from "../../src/api/routes/tasks.js";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { loadConfig } from "../../src/contracts/config/index.js";
import type { Candidate, RunRequest, TaskProgress } from "../../src/contracts/index.js";
import { createBillingStore } from "../../src/db/billing.js";
import type { EncryptedRecordStore } from "../../src/db/encrypted-records.js";
import { createRepoStore } from "../../src/db/repos.js";
import { createRunStore } from "../../src/db/runs.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import type { BatchStatus } from "../../src/generation/batches/progress.js";
import { testDatabase } from "./site-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
export const ROOT = "/api/orgs/team/repos/owner/repo/batches";
export async function fixture(
  options: {
    failStart?: boolean;
    failAttach?: boolean;
    sha?: string;
    records?: EncryptedRecordStore;
    billing?: boolean;
  } = {},
) {
  const database = await testDatabase();
  cleanups.push(() => database.close());
  const users = createUserStore(database.db, { secret: "batch-test-secret" });
  const user = await users.upsert({
    githubId: 1,
    login: "author",
    token: "secret-token",
    scopes: "repo",
    orgs: [{ githubId: 2, login: "team", role: "member" }],
  });
  const tenant = (await users.orgsFor(user.id)).find((org) => org.login === "team");
  if (!tenant) throw new Error("tenant missing");
  const repos = createRepoStore(database.db);
  const repo = await repos.connect({
    orgId: tenant.id,
    githubId: 10,
    fullName: "owner/repo",
    defaultBranch: "feature/main",
    private: true,
    connectedBy: user.id,
  });
  const runs = createRunStore(database.db);
  const tasks = createTaskStore(database.db);
  const directory = await mkdtemp(join(tmpdir(), "batch-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const artifacts = new LocalArtifactStore(directory);
  const started: RunRequest[] = [];
  const cancelled: string[] = [];
  const github: string[] = [];
  let snapshot: BatchStatus | undefined;
  const seen = new Map<string, TaskProgress>();
  const routes = createBatchRoutes({
    config: loadConfig({}),
    ...(options.records ? { records: options.records } : {}),
    auth: { githubApiUrl: "https://github.invalid" },
    users,
    repos,
    runs: options.failAttach
      ? {
          ...runs,
          attachRun: async () => {
            throw new Error("database unavailable");
          },
        }
      : runs,
    tasks,
    artifacts,
    fetchImpl: (async (url, init) => {
      github.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toContain("secret-token");
      return Response.json({ sha: options.sha ?? "a".repeat(40) });
    }) as typeof fetch,
    start: async (input) => {
      expect((await runs.runsFor(repo.id)).some((run) => run.runId === input.runId)).toBe(true);
      if (input.generation)
        expect((await options.records?.read(`generations/${input.runId}`))?.value).toEqual(
          input.generation,
        );
      if (options.failStart) throw new Error("ambiguous transport failure");
      started.push(input);
    },
    status: async (runId) =>
      snapshot ?? {
        runId,
        phase: "discovering",
        discovery: { wave: 0, totalShards: 3, completedShards: 1, failedShards: 1, candidates: 2 },
      },
    batch: async (runId) => {
      for (const task of snapshot?.tasks ?? []) seen.set(task.candidateId, task);
      return {
        run: { runId } as RunRequest,
        taskQueue: "test",
        phase: "authoring",
        shards: [],
        candidates: [...seen.values()].map((progress) => ({
          workflowId: `${runId}/candidate/${progress.candidateId}`,
          candidate: {
            candidateId: progress.candidateId,
            difficulty: progress.difficulty,
            sourcePr: 1,
            sourceUrl: "https://github.com/owner/repo/pull/1",
          } as Candidate,
          progress,
        })),
      };
    },
    cancel: async (runId) => {
      cancelled.push(runId);
    },
    ...(options.billing ? { billing: createBillingStore(database.db, true) } : {}),
  });
  const taskRoutes = createTaskRoutes({ users, repos, tasks, artifacts });
  const server = createServer(async (request, response) => {
    try {
      // Auth boundary equivalent to startApi: no user, no site route invocation.
      if (request.headers.authorization !== "Bearer test-session") {
        sendJson(response, 401, {});
        return;
      }
      if (
        !(await routes.handle(
          request,
          new URL(request.url ?? "/", "http://test"),
          response,
          user,
        )) &&
        !(await taskRoutes.handle(
          request,
          new URL(request.url ?? "/", "http://test"),
          response,
          user,
        ))
      )
        sendJson(response, 404, {});
    } catch (error) {
      sendApiError(response, error);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const request = (path = ROOT, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { authorization: "Bearer test-session", ...init?.headers },
    });
  const start = () =>
    request(ROOT, {
      method: "POST",
      body: JSON.stringify({ candidateCounts: { easy: 1, medium: 2, hard: 0 } }),
    });
  return {
    request,
    start,
    tenant,
    started,
    cancelled,
    github,
    artifacts,
    runs,
    repo,
    tasks,
    db: database.db,
    setStatus: (status: BatchStatus) => {
      snapshot = status;
    },
  };
}
