import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts/index.js";
import { loadWorkerConfig, type SelfBenchWorkerConfig } from "../contracts/config/index.js";
import { openDatabase } from "../db/client.js";
import { createUsageStore } from "../db/usage.js";
import { createVault } from "../db/vault.js";
import { createEvaluationActivities } from "../evaluation/activities.js";
import { createActivities } from "../generation/pipeline/activities.js";
import { runCommand } from "../lib/process.js";
import { validateE2BWorkerStartup } from "../sandbox/providers/e2b/startup.js";
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

const connection = await connectTemporalWorker(config.temporal);
// Stored credentials need both the database and the key; without them only local runs work.
const database =
  process.env.SELFBENCH_EVAL_CREDENTIAL_KEY && process.env.SELFBENCH_DATABASE_URL
    ? await openDatabase(process.env.SELFBENCH_DATABASE_URL)
    : undefined;
const vault = database
  ? createVault(database.db, process.env.SELFBENCH_EVAL_CREDENTIAL_KEY ?? "")
  : undefined;
const { compileAndVerify, ...generation } = createActivities(
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
    activities: { ...generation, ...evaluation },
    maxConcurrentActivityTaskExecutions: config.activityConcurrency,
    interceptors: { activity: [activityEventInterceptor()] },
  }),
  Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: harborTaskQueue(config.temporal.taskQueue),
    activities: { compileAndVerify, executeSolverEvaluation },
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

/** Fail at startup, not on the first activity, when a configured sandbox backend is unusable. */
async function checkSandboxBackends(worker: SelfBenchWorkerConfig): Promise<void> {
  if (worker.execution.kind === "docker" || worker.harborEnvironment === "docker") {
    await runCommand("docker", ["info"], { timeoutMs: 30_000 });
    await runCommand("docker", ["compose", "version"], { timeoutMs: 30_000 });
  }
  if (worker.execution.kind === "e2b") {
    await validateE2BWorkerStartup(worker.execution);
  }
}
