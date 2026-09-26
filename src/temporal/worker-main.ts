import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts/index.js";
import { loadWorkerConfig } from "../contracts/config/index.js";
import { workerProcessSettings } from "../contracts/config/worker.js";
import { openDatabase } from "../db/client.js";
import { createUsageStore } from "../db/usage.js";
import { createVault } from "../db/vault.js";
import { createEvaluationActivities } from "../evaluation/activities.js";
import { createActivities } from "../generation/pipeline/activities.js";
import { keepOpenRouterRatesFresh } from "../lib/openrouter-rates.js";
import { checkSandboxBackends } from "../sandbox/index.js";
import { removeEmptyModalCredentialOverrides } from "../sandbox/providers/modal/auth.js";
import { activityEventInterceptor } from "./activity-events.js";
import { connectTemporalWorker } from "./connection.js";
import { harborTaskQueue } from "./task-queues.js";
import { resolveHarborConcurrency } from "./worker-memory.js";

/**
 * The worker: generation and evaluation workflows and their sandbox activities on the configured
 * task queue, plus the Harbor activities on a sibling queue. Each Harbor activity hosts a
 * ~300 MiB Python client, so that queue's concurrency is sized to memory. `SELFBENCH_WORKER_ROLE`
 * limits a process to one queue so each can scale on its own backlog.
 */
removeEmptyModalCredentialOverrides();
const config = loadWorkerConfig();
const { role, shutdownGraceMs } = workerProcessSettings(process.env);
await checkSandboxBackends(config);
// Managed usage is billed at OpenRouter's live list prices; see openrouter-rates.ts.
await keepOpenRouterRatesFresh().ready;

const connection = await connectTemporalWorker(config.temporal);
// Stored credentials need both the database and the key; without them only local runs work.
const database =
  process.env.SELFBENCH_EVAL_CREDENTIAL_KEY && process.env.SELFBENCH_DATABASE_URL
    ? await openDatabase(process.env.SELFBENCH_DATABASE_URL)
    : undefined;
const vault = database
  ? createVault(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY ?? "")
  : undefined;
const { verifyCompiled, ...generation } = createActivities(
  config,
  vault,
  database ? createUsageStore(database.db) : undefined,
);
const { executeSolverEvaluation, ...evaluation } = createEvaluationActivities(
  createArtifactStore(config.artifact),
  vault,
);
const harborConcurrency = resolveHarborConcurrency(config.harborConcurrency);
// A stopping worker (SIGTERM on a scale-in or rollout) stops polling at once and lets in-flight
// activities finish for shutdownGraceMs; Temporal retries anything still running after it.

const workers = await Promise.all([
  ...(role === "harbor"
    ? []
    : [
        Worker.create({
          connection,
          namespace: config.temporal.namespace,
          taskQueue: config.temporal.taskQueue,
          workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
          activities: { ...generation, ...evaluation },
          maxConcurrentActivityTaskExecutions: config.activityConcurrency,
          interceptors: { activity: [activityEventInterceptor()] },
          shutdownGraceTime: shutdownGraceMs,
        }),
      ]),
  ...(role === "workflows"
    ? []
    : [
        Worker.create({
          connection,
          namespace: config.temporal.namespace,
          taskQueue: harborTaskQueue(config.temporal.taskQueue),
          activities: { verifyCompiled, executeSolverEvaluation },
          maxConcurrentActivityTaskExecutions: harborConcurrency,
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
try {
  await Promise.all(workers.map((worker) => worker.run()));
} finally {
  await database?.close();
}
