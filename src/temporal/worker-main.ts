import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts/index.js";
import { loadWorkerConfig } from "../contracts/config/index.js";
import { openDatabase } from "../db/client.js";
import { createSandboxSlots } from "../db/sandbox-slots.js";
import { createUsageStore } from "../db/usage.js";
import { createVault } from "../db/vault.js";
import { createEvaluationActivities } from "../evaluation/activities.js";
import { createActivities } from "../generation/pipeline/activities.js";
import {
  createSandboxSlotActivities,
  sandboxSlotLimit,
} from "../generation/pipeline/sandbox-slots.js";
import { keepOpenRouterRatesFresh } from "../lib/openrouter-rates.js";
import { checkSandboxBackends } from "../sandbox/index.js";
import { removeEmptyModalCredentialOverrides } from "../sandbox/providers/modal/auth.js";
import { activityEventInterceptor } from "./activity-events.js";
import { connectTemporalWorker } from "./connection.js";
import { harborTaskQueue } from "./task-queues.js";
import { resolveHarborConcurrency } from "./worker-memory.js";

/**
 * The combined worker: generation and evaluation workflows and their sandbox activities on the
 * configured task queue, plus the Harbor activities on a sibling queue. Each Harbor activity
 * hosts a ~300 MiB Python client, so that queue's concurrency is sized to memory.
 */
removeEmptyModalCredentialOverrides();
const config = loadWorkerConfig();
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

const workers = await Promise.all([
  Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
    activities: {
      ...generation,
      ...evaluation,
      ...createSandboxSlotActivities(
        database ? createSandboxSlots(database.db, sandboxSlotLimit()) : undefined,
      ),
    },
    maxConcurrentActivityTaskExecutions: config.activityConcurrency,
    interceptors: { activity: [activityEventInterceptor()] },
  }),
  Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: harborTaskQueue(config.temporal.taskQueue),
    activities: { verifyCompiled, executeSolverEvaluation },
    maxConcurrentActivityTaskExecutions: harborConcurrency,
  }),
]);
console.log(
  `SelfBench worker polling ${config.temporal.namespace}/${config.temporal.taskQueue} with activity concurrency ${config.activityConcurrency} and Harbor concurrency ${harborConcurrency}`,
);
try {
  await Promise.all(workers.map((worker) => worker.run()));
} finally {
  await database?.close();
}
