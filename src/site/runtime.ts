import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from "@temporalio/common";
import { queryStatus } from "../api/status.js";
import type { ArtifactStore } from "../artifacts.js";
import type { AuthConfig } from "../auth/config.js";
import { createSiteAuth, type SiteAuth } from "../auth/routes.js";
import { createUserStore } from "../auth/users.js";
import type { SelfBenchConfig } from "../config.js";
import { type OpenDatabase, openDatabase } from "../db/client.js";
import { createEncryptedRecords } from "../evaluation/encrypted-records.js";
import { createEvaluationRoutes } from "../evaluation/routes.js";
import { selfBenchRunWorkflow } from "../temporal/workflow.js";
import type { BatchStatus } from "./batch-progress.js";
import { type BatchRoutes, createBatchRoutes } from "./batch-routes.js";
import { type ConnectedRepoRoutes, createConnectedRepoRoutes } from "./connected-repos.js";
import { createGitHubRepoRoutes, type GitHubRepoRoutes } from "./github-repos.js";
import { createPullRequestRoutes, type PullRequestRoutes } from "./pr-routes.js";
import { createRepoStore } from "./repo-store.js";
import { createRunStore } from "./run-store.js";
import { createTaskStore } from "./task-store.js";
import { createTaskRoutes, type TaskRoutes } from "./tasks.js";
import { temporalStarter, temporalStatus } from "./temporal-status.js";

interface Site {
  readonly auth: SiteAuth;
  readonly github: GitHubRepoRoutes;
  readonly repos: ConnectedRepoRoutes;
  readonly tasks: TaskRoutes;
  readonly batches: BatchRoutes;
  readonly pullRequests: PullRequestRoutes;
  readonly evaluations: ReturnType<typeof createEvaluationRoutes>;
  readonly database: OpenDatabase;
}

export async function openSite(
  auth: AuthConfig,
  config: SelfBenchConfig,
  client: Client,
  artifacts: ArtifactStore,
): Promise<Site> {
  const database = await openDatabase(auth.databaseUrl);
  const users = createUserStore(database.db, { secret: auth.sessionSecret });
  const repos = createRepoStore(database.db);
  const tasks = createTaskStore(database.db);
  const runs = createRunStore(database.db);
  return {
    auth: createSiteAuth({ config: auth, users }),
    evaluations: createEvaluationRoutes({
      users,
      repos,
      tasks,
      artifacts,
      publicUrl: process.env.SELFBENCH_SITE_FRONTEND_URL ?? auth.publicUrl,
      ...(process.env.SELFBENCH_EVAL_CREDENTIAL_KEY
        ? {
            records: createEncryptedRecords(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY),
          }
        : {}),
      async start(input) {
        try {
          await client.workflow.start("selfBenchEvaluationWorkflow", {
            workflowId: `evaluation/${input.repoId}/${input.id}`,
            taskQueue: input.credentialOrgId
              ? (process.env.SELFBENCH_GENERATION_TASK_QUEUE ?? config.temporal.taskQueue)
              : (process.env.SELFBENCH_EVAL_TASK_QUEUE ?? config.temporal.taskQueue),
            args: [input],
            workflowExecutionTimeout: "73 hours",
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        }
      },
    }),
    github: createGitHubRepoRoutes({ config: auth, users }),
    repos: createConnectedRepoRoutes({ config: auth, users, repos }),
    batches: createBatchRoutes({
      config,
      auth,
      users,
      repos,
      runs,
      tasks,
      artifacts,
      start: async (input) => {
        await client.workflow.start(selfBenchRunWorkflow, {
          workflowId: input.runId,
          taskQueue: config.temporal.taskQueue,
          args: [input],
          workflowExecutionTimeout: "14 days",
        });
      },
      status: async (runId) => (await queryStatus(client.workflow.getHandle(runId))) as BatchStatus,
      cancel: async (runId) => {
        await client.workflow.getHandle(runId).cancel();
      },
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
      ...(process.env.SELFBENCH_EVAL_CREDENTIAL_KEY && process.env.SELFBENCH_GENERATION_TASK_QUEUE
        ? {
            records: createEncryptedRecords(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY),
          }
        : {}),
      users,
      repos,
      tasks,
      artifacts,
      start: (workflowId, input) =>
        temporalStarter(
          client,
          input.run.generation
            ? (process.env.SELFBENCH_GENERATION_TASK_QUEUE ?? config.temporal.taskQueue)
            : config.temporal.taskQueue,
        )(workflowId, input),
    }),
    database,
  };
}
