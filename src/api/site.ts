import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../artifacts/index.js";
import type { SelfBenchConfig } from "../contracts/config/index.js";
import { createApiKeyStore } from "../db/api-keys.js";
import { createBillingStore } from "../db/billing.js";
import { type OpenDatabase, openDatabase } from "../db/client.js";
import { createRunSummaryStore } from "../db/evaluation-summaries.js";
import { createReleaseStore } from "../db/releases.js";
import { createRepoStore } from "../db/repos.js";
import { createRunStore } from "../db/runs.js";
import { createTaskStore } from "../db/tasks.js";
import { createUsageStore } from "../db/usage.js";
import { createUserStore } from "../db/users.js";
import { createVault } from "../db/vault.js";
import { evaluationStarter, evaluationStopper } from "../evaluation/start.js";
import { keepRunSummaries } from "../evaluation/store.js";
import { createGenerationBatches } from "../generation/batches/service.js";
import { loadStripeConfig } from "../generation/billing/config.js";
import { generationCost } from "../generation/billing/cost-status.js";
import { managedOfferingEnabled } from "../generation/billing/managed.js";
import { startBillingDispatcher } from "../generation/billing/outbox.js";
import { generationRecordPath } from "../generation/settings/credentials.js";
import type { GenerationReference } from "../generation/settings/settings.js";
import { temporalStarter, temporalStatus } from "../generation/tasks/workflow-client.js";
import { projectRoot } from "../lib/project-paths.js";
import { taskCanary } from "../public/task-canary.js";
import type { AuthConfig } from "./auth/config.js";
import { createIndexNow } from "./indexnow.js";
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
  /** Present only with the managed offering; a BYOK-only deployment has no billing routes. */
  readonly billing?: BillingRoutes;
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
  /** Tags for the results site pages' head: the telemetry config. */
  head: string,
): Promise<Site> {
  const database = await openDatabase(auth.databaseUrl);
  keepRunSummaries(artifacts, createRunSummaryStore(database.db));
  const users = createUserStore(database.db, { secret: auth.sessionSecret });
  const apiKeys = createApiKeyStore(database.db);
  const managedOffering = managedOfferingEnabled();
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
  // Only prod's site may be indexed; dev's, and any local run, never tells a search engine.
  const indexable = process.env.SELFBENCH_RESULTS_SITE_INDEX === "true";
  const indexNow =
    resultsSiteUrl && indexable ? createIndexNow({ siteUrl: resultsSiteUrl }) : undefined;
  // Anonymous reads share this server with the app: one scraper must not slow the app down.
  const limiter = createRateLimiter({
    perMinute: 300,
    burst: 60,
    onLimit: (client) => console.warn(`public site rate limit refused requests from ${client}`),
  });
  // SelfBench's canary GUID, from deploy config (a Secret Manager secret in the cloud), so it is
  // never in this repository; without one, published tasks are served as they are.
  const canaryGuid = process.env.SELFBENCH_TASK_CANARY;
  const canary = taskCanary(canaryGuid);
  if (canaryGuid && !canary)
    console.error("SELFBENCH_TASK_CANARY is not a GUID; published tasks are served without one");
  const publicReleases = createPublicReleaseRoutes(releases, {
    limiter,
    artifacts,
    ...(canary ? { taskCanary: canary } : {}),
  });
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
  );
  return {
    users,
    close: async () => {
      await billingDispatcher?.close();
    },
    generationBatches: batches,
    ...(managedOffering
      ? {
          billing: createBillingRoutes({
            users,
            store: billingStore,
            ...(stripe ? { config: stripe } : {}),
            publicUrl,
          }),
        }
      : {}),
    auth: createSiteAuth({ config: auth, users, apiKeys, managedOffering }),
    apiKeys: createApiKeyRoutes({ keys: apiKeys, publicUrl }),
    evaluations: createEvaluationRoutes({
      users,
      repos,
      tasks,
      artifacts,
      publicUrl,
      ...(vault ? { vault } : {}),
      start: evaluationStarter(client, config.temporal.taskQueue),
      stop: evaluationStopper(client),
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
      onPublicChange: ({ fullName, publisher }) => {
        publicReleases.refresh();
        // The repository's page, the publisher's line, and the home page's directory.
        void indexNow?.changed(["/", `/${fullName}`, `/${fullName}/${publisher}`]);
      },
    }),
    publicReleases,
    ...(resultsSiteUrl
      ? {
          resultsSite: createResultsSite({
            siteUrl: resultsSiteUrl,
            appUrl: publicUrl,
            indexable,
            root: `${projectRoot(import.meta.url)}/dist/public-site`,
            publicRoutes: publicReleases,
            limiter,
            head,
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
      start: (input) => batches.start(input),
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
