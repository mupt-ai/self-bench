import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts.js";
import { createSiteAuth } from "../../src/auth/routes.js";
import { createSessionSigner, SESSION_COOKIE } from "../../src/auth/session.js";
import { createUserStore } from "../../src/auth/users.js";
import type { CodexLogins } from "../../src/evaluation/codex-login.js";
import {
  createEncryptedRecords,
  type EncryptedRecordStore,
} from "../../src/evaluation/encrypted-records.js";
import { createEvaluationRoutes } from "../../src/evaluation/routes.js";
import type { EvaluationInput } from "../../src/evaluation/types.js";
import { createRepoStore } from "../../src/site/repo-store.js";
import { createTaskStore } from "../../src/site/task-store.js";
import { testAuthConfig, testDatabase } from "./site-fixture.js";

export const evaluationEnv = {
  SELFBENCH_EVAL_CREDENTIAL_KEY: "a".repeat(64),
  SELFBENCH_EVAL_MODELS: JSON.stringify([
    {
      id: "openai-test",
      label: "Test model",
      model: "openai/test-model",
      harnesses: ["codex", "pi"],
      tenants: ["avyay"],
      credentialEnv: "SELFBENCH_EVAL_SECRET_TEST",
    },
  ]),
  SELFBENCH_EVAL_SANDBOXES: '["docker","modal"]',
  SELFBENCH_EVAL_SECRET_TEST: "test-model-secret-never-publish",
};
export function evaluationInput(): EvaluationInput {
  return {
    id: crypto.randomUUID(),
    repoId: 1,
    tenant: "avyay",
    startedBy: "avyay",
    createdAt: new Date().toISOString(),
    model: "openai-test",
    modelName: "openai/test-model",
    harnesses: ["codex"],
    sandbox: "docker",
    tasks: [{ runId: "run-one", taskId: "task-one", bundleKey: "tasks/task.tar.gz" }],
  };
}
export async function evaluationServer(records?: EncryptedRecordStore, codexLogins?: CodexLogins) {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-routes-"));
  const artifacts = new LocalArtifactStore(directory);
  const database = await testDatabase();
  const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
  const user = await users.upsert({
    githubId: 1,
    login: "avyay",
    token: "github-secret",
    scopes: "repo",
    orgs: [],
  });
  const outsider = await users.upsert({
    githubId: 2,
    login: "outsider",
    token: "other-secret",
    scopes: "repo",
    orgs: [],
  });
  const tenant = (await users.orgsFor(user.id))[0];
  if (!tenant) throw new Error("Missing test tenant");
  const repos = createRepoStore(database.db);
  const repo = await repos.connect({
    orgId: tenant.id,
    githubId: 1,
    fullName: "avyay/repo",
    defaultBranch: "main",
    private: true,
    connectedBy: user.id,
  });
  const secondRepo = await repos.connect({
    orgId: tenant.id,
    githubId: 2,
    fullName: "avyay/other",
    defaultBranch: "main",
    private: true,
    connectedBy: user.id,
  });
  const tasks = createTaskStore(database.db);
  await tasks.upsertMany([
    {
      repoId: repo.id,
      runId: "run-one",
      candidateId: "candidate-one",
      taskId: "task-one",
      pipelineStatus: "accepted",
      stage: "accepted",
      difficulty: "easy",
      bundleKey: "tasks/task.tar.gz",
    },
    {
      repoId: secondRepo.id,
      runId: "run-other",
      candidateId: "candidate-other",
      taskId: "task-other",
      pipelineStatus: "accepted",
      stage: "accepted",
      difficulty: "easy",
      bundleKey: "tasks/other.tar.gz",
    },
  ]);
  const approved = await tasks.find(repo.id, "run-one", "task-one");
  if (!approved) throw new Error("Missing fixture task");
  await tasks.review(approved.id, { decision: "approve", note: "Reviewed", userId: user.id });
  const starts: EvaluationInput[] = [];
  let failStart = false;
  const auth = createSiteAuth({
    config: testAuthConfig,
    users,
    fetchImpl: (async (input, init) => {
      if (String(input) !== `${testAuthConfig.githubApiUrl}/user`) {
        throw new Error("Unexpected mock GitHub request");
      }
      const token = new Headers(init?.headers).get("authorization");
      if (token === "Bearer github-secret") return Response.json({ id: 1 });
      if (token === "Bearer other-secret") return Response.json({ id: 2 });
      return new Response(null, { status: 401 });
    }) as typeof fetch,
  });
  let publicUrl = "";
  const server = createServer(async (request, response) => {
    try {
      const signedIn = await auth.authenticate(request);
      if (!signedIn) {
        response.writeHead(401).end();
        return;
      }
      const routes = createEvaluationRoutes({
        users,
        repos,
        tasks,
        artifacts,
        publicUrl,
        ...(codexLogins ? { codexLogins } : {}),
        env: evaluationEnv,
        records:
          records ??
          createEncryptedRecords(database.db, evaluationEnv.SELFBENCH_EVAL_CREDENTIAL_KEY),
        async start(input) {
          if (failStart) throw new Error("mock connection lost");
          starts.push(input);
        },
      });
      if (
        !(await routes.handle(request, new URL(request.url ?? "/", publicUrl), response, signedIn))
      )
        response.writeHead(404).end();
    } catch {
      response
        .writeHead(503, { "content-type": "application/json" })
        .end('{"error":"Submission not confirmed"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  publicUrl = `http://127.0.0.1:${address.port}`;
  const signer = createSessionSigner(testAuthConfig.sessionSecret);
  return {
    users,
    artifacts,
    tasks,
    repo,
    starts,
    outsider,
    base: "/api/orgs/avyay/repos/avyay/repo/evaluations",
    failStart(value: boolean) {
      failStart = value;
    },
    request(path: string, init: RequestInit = {}, githubId: number | null = 1) {
      return fetch(`${publicUrl}${path}`, {
        ...init,
        headers: {
          origin: publicUrl,
          "content-type": "application/json",
          ...(githubId === null ? {} : { cookie: `${SESSION_COOKIE}=${signer.issue(githubId)}` }),
          ...init.headers,
        },
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
