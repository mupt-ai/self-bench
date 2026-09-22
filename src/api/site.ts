import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../artifacts.js";
import { type ApiKeyRoutes, createApiKeyRoutes } from "../auth/api-key-routes.js";
import { createApiKeyStore } from "../auth/api-keys.js";
import type { AuthConfig } from "../auth/config.js";
import { createSiteAuth, type SiteAuth } from "../auth/routes.js";
import { createUserStore } from "../auth/users.js";
import { type BatchRoutes, createBatchRoutes } from "../batches/routes.js";
import { createGenerationBatches } from "../batches/service.js";
import { loadStripeConfig } from "../billing/config.js";
import { startBillingDispatcher } from "../billing/outbox.js";
import { type BillingRoutes, createBillingRoutes } from "../billing/routes.js";
import { createBillingStore } from "../billing/store.js";
import type { SelfBenchConfig } from "../config.js";
import { type OpenDatabase, openDatabase } from "../db/client.js";
import { createEncryptedRecords } from "../evaluation/encrypted-records.js";
import { createEvaluationRoutes } from "../evaluation/routes.js";
import { evaluationStarter } from "../evaluation/start.js";
import { temporalStarter, temporalStatus } from "../generation/candidate-workflows.js";
import { generationRecordPath } from "../generation/credentials.js";
import type { GenerationReference } from "../generation/settings.js";
import { createGitHubRepoRoutes, type GitHubRepoRoutes } from "../github/repo-routes.js";
import { generationCost } from "../managed/cost-status.js";
import { createUsageStore } from "../managed/usage-store.js";
import { type ConnectedRepoRoutes, createConnectedRepoRoutes } from "../repos/routes.js";
import { createRepoStore } from "../repos/store.js";
import { createPullRequestRoutes, type PullRequestRoutes } from "../tasks/pr-routes.js";
import { createTaskRoutes, type TaskRoutes } from "../tasks/routes.js";
import { createRunStore } from "../tasks/run-store.js";
import { createTaskStore } from "../tasks/store.js";

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
  readonly billing: BillingRoutes;
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
  const stripe = loadStripeConfig();
  const billingStore = createBillingStore(database.db, !!stripe);
  const billingDispatcher = stripe ? startBillingDispatcher(billingStore, stripe) : undefined;
  const publicUrl = auth.publicUrl;
  const repos = createRepoStore(database.db);
  const tasks = createTaskStore(database.db);
  const runs = createRunStore(database.db);
  const usage = createUsageStore(database.db);
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
    close: async () => {
      await batches.close();
      await billingDispatcher?.close();
    },
    generationBatches: batches,
    billing: createBillingRoutes({
      users,
      store: billingStore,
      ...(stripe ? { config: stripe } : {}),
      publicUrl,
    }),
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
      billing: billingStore,
    }),
    tasks: createTaskRoutes({
      users,
      repos,
      tasks,
      artifacts,
      status: temporalStatus(client),
      ...(generationRecords
        ? {
            cost: async (runId, orgId, candidateId, live) => {
              const saved = await generationRecords.read<GenerationReference>(
                generationRecordPath(runId),
              );
              const generation = saved?.value;
              if (!generation || (generation.orgId ?? generation.ownerId) !== orgId)
                return undefined;
              return generationCost(
                await usage.summary(runId, orgId, { candidateId }),
                generation.settings.sandbox === "managed" ? "e2b" : generation.settings.sandbox,
                generation.settings.authorModel,
                live,
              );
            },
          }
        : {}),
    }),
    pullRequests: createPullRequestRoutes({
      config,
      auth,
      ...(generationRecords ? { records: generationRecords } : {}),
      users,
      repos,
      tasks,
      artifacts,
      billing: billingStore,
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
