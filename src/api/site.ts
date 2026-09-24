import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../artifacts/index.js";
import type { SelfBenchConfig } from "../contracts/config/index.js";
import { createApiKeyStore } from "../db/api-keys.js";
import { createBillingStore } from "../db/billing.js";
import { type OpenDatabase, openDatabase } from "../db/client.js";
import { createReleaseStore } from "../db/releases.js";
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
import { projectRoot } from "../lib/project-paths.js";
import type { AuthConfig } from "./auth/config.js";
import { createRateLimiter } from "./rate-limit.js";
import { createResultsSite, type ResultsSite } from "./results-site.js";
import { type ApiKeyRoutes, createApiKeyRoutes } from "./routes/api-keys.js";
import { createSiteAuth, type SiteAuth } from "./routes/auth.js";
import { type BatchRoutes, createBatchRoutes } from "./routes/batches.js";
import { type BillingRoutes, createBillingRoutes } from "./routes/billing.js";
import { createEvaluationRoutes } from "./routes/evaluations.js";
import { createGitHubRepoRoutes, type GitHubRepoRoutes } from "./routes/github-repos.js";
import { createPublicReleaseRoutes, type PublicReleaseRoutes } from "./routes/public-releases.js";
import { createPullRequestRoutes, type PullRequestRoutes } from "./routes/pull-requests.js";
import { createReleaseRoutes, type ReleaseRoutes } from "./routes/releases.js";
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
  readonly releases: ReleaseRoutes;
  /** Routes that need no sign-in; selfbench.dev reads published releases from them. */
  readonly publicReleases: PublicReleaseRoutes;
  /** selfbench.dev itself, answered on its own host by this same server, when configured. */
  readonly resultsSite?: ResultsSite;
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
  const releases = createReleaseStore(database.db);
  // Unset means no public results site: no host serves it and nothing links to it.
  const resultsSiteUrl = process.env.SELFBENCH_RESULTS_SITE_URL?.trim().replace(/\/+$/, "") || null;
  // Anonymous reads share this server with the app: a scraper must not slow the app down.
  const limiter = createRateLimiter({
    perMinute: 300,
    burst: 60,
    globalPerMinute: 6_000,
    globalBurst: 600,
    onLimit: (client, scope) =>
      console.warn(`public site rate limit (${scope}) refused requests from ${client}`),
    forwardedHops: Number(process.env.SELFBENCH_FORWARDED_HOPS) || 1,
  });
  const publicReleases = createPublicReleaseRoutes(releases, { limiter });
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
    releases: createReleaseRoutes({
      db: database.db,
      artifacts,
      users,
      repos,
      releases,
      publicUrl,
      githubApiUrl: auth.githubApiUrl,
      resultsSiteUrl,
    }),
    publicReleases,
    ...(resultsSiteUrl
      ? {
          resultsSite: createResultsSite({
            siteUrl: resultsSiteUrl,
            appUrl: publicUrl,
            indexable: process.env.SELFBENCH_RESULTS_SITE_INDEX === "true",
            root: `${projectRoot(import.meta.url)}/dist/public-site`,
            releases,
            publicRoutes: publicReleases,
            limiter,
          }),
        }
      : {}),
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
