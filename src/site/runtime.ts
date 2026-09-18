import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../artifacts.js";
import { type ApiKeyRoutes, createApiKeyRoutes } from "../auth/api-key-routes.js";
import { createApiKeyStore } from "../auth/api-keys.js";
import type { AuthConfig } from "../auth/config.js";
import { createSiteAuth, type SiteAuth } from "../auth/routes.js";
import { createUserStore } from "../auth/users.js";
import { createGenerationBatches } from "../batches/service.js";
import type { SelfBenchConfig } from "../config.js";
import { type OpenDatabase, openDatabase } from "../db/client.js";
import { createEncryptedRecords } from "../evaluation/encrypted-records.js";
import { createEvaluationRoutes } from "../evaluation/routes.js";
import { type BatchRoutes, createBatchRoutes } from "./batch-routes.js";
import { type ConnectedRepoRoutes, createConnectedRepoRoutes } from "./connected-repos.js";
import { evaluationStarter } from "./evaluation-start.js";
import { createGitHubRepoRoutes, type GitHubRepoRoutes } from "./github-repos.js";
import { createPullRequestRoutes, type PullRequestRoutes } from "./pr-routes.js";
import { createRepoStore } from "./repo-store.js";
import { createRunStore } from "./run-store.js";
import { createTaskStore } from "./task-store.js";
import { createTaskRoutes, type TaskRoutes } from "./tasks.js";
import { temporalStarter, temporalStatus } from "./temporal-status.js";

interface Site {
  users: ReturnType<typeof createUserStore>;
  readonly auth: SiteAuth;
  readonly apiKeys: ApiKeyRoutes;
  readonly github: GitHubRepoRoutes;
  readonly repos: ConnectedRepoRoutes;
  readonly tasks: TaskRoutes;
  readonly batches: BatchRoutes;
  readonly pullRequests: PullRequestRoutes;
  readonly evaluations: ReturnType<typeof createEvaluationRoutes>;
  readonly database: OpenDatabase;
  generationBatches: ReturnType<typeof createGenerationBatches>;
  close(): Promise<void>;
}

export async function openSite(
  auth: AuthConfig,
  config: SelfBenchConfig,
  client: Client,
  artifacts: ArtifactStore,
): Promise<Site> {
  const database = await openDatabase(auth.databaseUrl);
  const users = createUserStore(database.db, { secret: auth.sessionSecret });
  const apiKeys = createApiKeyStore(database.db);
  /** The origin browsers send; a separate frontend URL wins when the site is served from one. */
  const publicUrl = process.env.SELFBENCH_SITE_FRONTEND_URL ?? auth.publicUrl;
  const repos = createRepoStore(database.db);
  const tasks = createTaskStore(database.db);
  const runs = createRunStore(database.db);
  const generationQueue = process.env.SELFBENCH_GENERATION_TASK_QUEUE;
  const generationRecords =
    process.env.SELFBENCH_EVAL_CREDENTIAL_KEY && generationQueue
      ? createEncryptedRecords(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY)
      : undefined;
  const batches = createGenerationBatches(
    database.db,
    client,
    artifacts,
    generationQueue ?? config.temporal.taskQueue,
    generationRecords,
  );
  return {
    users,
    close: () => batches.close(),
    generationBatches: batches,
    auth: createSiteAuth({ config: auth, users, apiKeys }),
    apiKeys: createApiKeyRoutes({ keys: apiKeys, publicUrl }),
    evaluations: createEvaluationRoutes({
      users,
      repos,
      tasks,
      artifacts,
      publicUrl,
      ...(process.env.SELFBENCH_EVAL_CREDENTIAL_KEY
        ? {
            records: createEncryptedRecords(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY),
          }
        : {}),
      start: evaluationStarter(client, config.temporal.taskQueue),
    }),
    github: createGitHubRepoRoutes({ config: auth, users }),
    repos: createConnectedRepoRoutes({ config: auth, users, repos }),
    batches: createBatchRoutes({
      config,
      ...(generationRecords ? { records: generationRecords } : {}),
      auth,
      users,
      repos,
      runs,
      tasks,
      artifacts,
      start: (input, token) => batches.start(input, token),
      status: (runId) => batches.status(runId),
      cancel: (runId) => batches.cancel(runId),
    }),
    tasks: createTaskRoutes({
      users,
      repos,
      tasks,
      artifacts,
      status: temporalStatus(client),
    }),
    pullRequests: createPullRequestRoutes({
      config,
      auth,
      ...(generationRecords ? { records: generationRecords } : {}),
      users,
      repos,
      tasks,
      artifacts,
      start: (workflowId, input) =>
        temporalStarter(
          client,
          input.run.generation
            ? (generationQueue ?? config.temporal.taskQueue)
            : config.temporal.taskQueue,
        )(workflowId, input),
    }),
    database,
  };
}
