import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts/index.js";
import { loadWorkerConfig } from "../contracts/config/index.js";
import { workerProcessSettings } from "../contracts/config/worker.js";
import { createBatchStore } from "../db/batches.js";
import { openDatabase } from "../db/client.js";
import { createRunSummaryStore } from "../db/evaluation-summaries.js";
import { createRunStore } from "../db/runs.js";
import { createTaskStore } from "../db/tasks.js";
import { createUsageStore } from "../db/usage.js";
import { createVault } from "../db/vault.js";
import { createEvaluationActivities } from "../evaluation/activities.js";
import { keepRunSummaries } from "../evaluation/store.js";
import { keepGatewaysFresh } from "../gateways/refresh.js";
import { createBatchActivities } from "../generation/batches/activities.js";
import { taskImageBuilder } from "../generation/images/builder.js";
import { createActivities } from "../generation/pipeline/activities.js";
import { createTaskActivities } from "../generation/tasks/activities.js";
import { taskImageWorkerActivities } from "../generation/tasks/task-images-activity.js";
import { closeSentry, initSentry } from "../lib/telemetry/sentry.js";
import { checkSandboxBackends } from "../sandbox/index.js";
import { removeEmptyModalCredentialOverrides } from "../sandbox/providers/modal/auth.js";
import { activityErrorInterceptor } from "./activity-errors.js";
import { activityEventInterceptor } from "./activity-events.js";
import { harborQueue } from "./activity-options.js";
import { connectTemporalWorker } from "./connection.js";
import { idleTracker } from "./idle-exit.js";
import { resolveHarborConcurrency } from "./worker-memory.js";

/**
 * The worker: generation and evaluation workflows and their sandbox activities on the configured
 * task queue, plus the Harbor activities on a sibling queue. Each Harbor activity hosts a
 * ~300 MiB Python client, so that queue's concurrency is sized to memory. `SELFBENCH_WORKER_ROLE`
 * limits a process to one queue so each can scale on its own backlog.
 */
initSentry("worker");
removeEmptyModalCredentialOverrides();
const config = loadWorkerConfig();
const { role, shutdownGraceMs, idleExitMs } = workerProcessSettings(process.env);
await checkSandboxBackends(config);
// Managed usage is billed at OpenRouter's live list prices; see gateways/refresh.ts.
await keepGatewaysFresh().ready;

const connection = await connectTemporalWorker(config.temporal);
// Batches need the database; stored credentials need it and the key, without which only
// local runs work.
const database = process.env.SELFBENCH_DATABASE_URL
  ? await openDatabase(process.env.SELFBENCH_DATABASE_URL, { light: role === "harbor" })
  : undefined;
const vault =
  database && process.env.SELFBENCH_EVAL_CREDENTIAL_KEY
    ? createVault(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY)
    : undefined;
const usage = vault && database ? createUsageStore(database.db) : undefined;
const artifacts = createArtifactStore(config.artifact);
if (database) keepRunSummaries(artifacts, createRunSummaryStore(database.db));
const { verifyCompiled, ...generation } = createActivities(config, vault, usage);
// Batches and task rows need the database; candidate workflows write their rows through it.
const tasks = database ? createTaskStore(database.db) : undefined;
const batches =
  database && tasks
    ? {
        ...createBatchActivities({
          store: createBatchStore(database.db),
          tasks,
          runs: createRunStore(database.db),
          artifacts,
          ...(vault ? { vault } : {}),
          ...(usage ? { usage } : {}),
        }),
        ...createTaskActivities({ tasks, artifacts }),
      }
    : {};
const { secret: snapshotSecret, url: snapshotOrigin } = config.sandboxCallback ?? {};
// A stopping worker (SIGTERM on a preemption, scale-in or rollout) stops polling at once through
// Temporal's handler, installed with the connection, and lets in-flight activities finish for
// shutdownGraceMs. Trials not yet solving leave for another worker instead: the pod is usually
// killed long before one could finish.
const stopping = new AbortController();
process.once("SIGTERM", () => stopping.abort());
const { runSolverTrial, prepareTaskImages, ...evaluation } = createEvaluationActivities(
  artifacts,
  vault,
  snapshotSecret && snapshotOrigin ? { secret: snapshotSecret, url: snapshotOrigin } : undefined,
  stopping.signal,
);
// A rejected or deleted task's images go; the reconcile needs the task rows.
const builder = taskImageBuilder(config.taskImages);
// Rebuilding a task's images runs its gates again, with the credentials that checked it.
const { taskImages, rebuilds } = taskImageWorkerActivities(
  database?.db,
  artifacts,
  config.taskImages?.repository,
  vault && builder && snapshotSecret && snapshotOrigin
    ? {
        vault,
        builder,
        serving: { env: process.env, callback: { url: snapshotOrigin, secret: snapshotSecret } },
      }
    : undefined,
);
const harborConcurrency = resolveHarborConcurrency(config.harborConcurrency);
const idle = idleTracker();
const workers = await Promise.all([
  ...(role === "harbor"
    ? []
    : [
        Worker.create({
          connection,
          namespace: config.temporal.namespace,
          taskQueue: config.temporal.taskQueue,
          workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
          activities: { ...generation, ...evaluation, ...batches, ...taskImages },
          maxConcurrentActivityTaskExecutions: config.activityConcurrency,
          interceptors: {
            activity: [activityEventInterceptor(), activityErrorInterceptor(), idle.interceptor],
          },
          shutdownGraceTime: shutdownGraceMs,
        }),
      ]),
  ...(role === "workflows"
    ? []
    : [
        Worker.create({
          connection,
          namespace: config.temporal.namespace,
          taskQueue: harborQueue(config.temporal.taskQueue),
          activities: {
            verifyCompiled,
            runSolverTrial,
            prepareTaskImages,
            ...rebuilds,
          },
          maxConcurrentActivityTaskExecutions: harborConcurrency,
          interceptors: { activity: [activityErrorInterceptor(), idle.interceptor] },
          shutdownGraceTime: shutdownGraceMs,
        }),
      ]),
]);
const slots = [
  ...(role === "harbor" ? [] : [`activity concurrency ${config.activityConcurrency}`]),
  ...(role === "workflows" ? [] : [`Harbor concurrency ${harborConcurrency}`]),
];
console.log(
  `SelfBench ${role} worker polling ${config.temporal.namespace}/${config.temporal.taskQueue} with ${slots.join(" and ")}`,
);
if (idleExitMs) {
  // A job-style worker stops polling once idle, or after a day so it drains well inside
  // Autopilot's seven-day protection of a running pod; running() returns once it has drained.
  const startedAt = Date.now();
  const check = setInterval(() => {
    if (idle.idleForMs() < idleExitMs && Date.now() - startedAt < 24 * 60 * 60 * 1000) return;
    clearInterval(check);
    console.log(`SelfBench ${role} worker stopping: idle or retired, draining in-flight work`);
    for (const worker of workers) worker.shutdown();
  }, 30_000);
}
try {
  await Promise.all(workers.map((worker) => worker.run()));
} finally {
  try {
    await database?.close();
  } finally {
    await closeSentry();
  }
}
