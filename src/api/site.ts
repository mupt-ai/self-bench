import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../artifacts/index.js";
import type { SelfBenchConfig } from "../contracts/config/index.js";
import { createApiKeyStore } from "../db/api-keys.js";
import { createBillingStore } from "../db/billing.js";
import { type OpenDatabase, openDatabase } from "../db/client.js";
import { createRepoStore } from "../db/repos.js";
import { createRunStore } from "../db/runs.js";
import { createTaskStore } from "../db/tasks.js";
import { createUsageStore } from "../db/usage.js";
import { createUserStore } from "../db/users.js";
import { createVault } from "../db/vault.js";
import { evaluationStarter } from "../evaluation/start.js";
import { createGenerationBatches } from "../generation/batches/service.js";
import { loadStripeConfig } from "../generation/billing/config.js";
import { generationCost } from "../generation/billing/cost-status.js";
import { startBillingDispatcher } from "../generation/billing/outbox.js";
import { generationRecordPath } from "../generation/settings/credentials.js";
import type { GenerationReference } from "../generation/settings/settings.js";
import { temporalStarter, temporalStatus } from "../generation/tasks/workflow-client.js";
import type { AuthConfig } from "./auth/config.js";
import { type ApiKeyRoutes, createApiKeyRoutes } from "./routes/api-keys.js";
import { createSiteAuth, type SiteAuth } from "./routes/auth.js";
import { type BatchRoutes, createBatchRoutes } from "./routes/batches.js";
import { type BillingRoutes, createBillingRoutes } from "./routes/billing.js";
import { createEvaluationRoutes } from "./routes/evaluations.js";
import { createGitHubRepoRoutes, type GitHubRepoRoutes } from "./routes/github-repos.js";
import { createPullRequestRoutes, type PullRequestRoutes } from "./routes/pull-requests.js";
import { type ConnectedRepoRoutes, createConnectedRepoRoutes } from "./routes/repos.js";
import { createTaskRoutes, type TaskRoutes } from "./routes/tasks.js";

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
  const vault = process.env.SELFBENCH_EVAL_CREDENTIAL_KEY
    ? createVault(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY)
    : undefined;
  // Hosted generation also needs its own queue; without one only evaluations use the vault.
  const generationVault = generationQueue ? vault : undefined;
  const batches = createGenerationBatches(
    database.db,
    client,
    artifacts,
    generationQueue ?? config.temporal.taskQueue,
    generationVault,
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
      ...(vault ? { vault } : {}),
      start: evaluationStarter(client, config.temporal.taskQueue),
    }),
    github: createGitHubRepoRoutes({ config: auth, users }),
    repos: createConnectedRepoRoutes({ config: auth, users, repos }),
    batches: createBatchRoutes({
      config,
      ...(generationVault ? { vault: generationVault } : {}),
      auth,
      users,
      repos,
      runs,
      tasks,
      artifacts,
      start: (input, token) => batches.start(input, token),
      status: (runId) => batches.status(runId),
      batch: (runId) => batches.read(runId),
      cancel: (runId) => batches.cancel(runId),
      billing: billingStore,
    }),
    tasks: createTaskRoutes({
      users,
      repos,
      tasks,
      artifacts,
      status: temporalStatus(client),
      ...(generationVault
        ? {
            cost: async (runId, orgId, candidateId, live) => {
              const saved = await generationVault.records.read<GenerationReference>(
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
      ...(generationVault ? { vault: generationVault } : {}),
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
