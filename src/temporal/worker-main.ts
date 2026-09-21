import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts.js";
import { loadWorkerConfig } from "../config.js";
import { createEvaluationActivities } from "../evaluation/activities.js";
import { openWorkerRecords } from "../evaluation/worker-records.js";
import { createUsageStore } from "../managed/usage-store.js";
import { runCommand } from "../process.js";
import { validateE2BWorkerStartup } from "../sandbox/providers/e2b/startup.js";
import { removeEmptyModalCredentialOverrides } from "../sandbox/providers/modal/auth.js";

import { createActivities } from "./activities.js";
import { activityEventInterceptor } from "./activity-events.js";
import { connectTemporalWorker } from "./connection.js";
import { harborTaskQueue } from "./task-queues.js";
import { resolveHarborConcurrency } from "./worker-memory.js";

removeEmptyModalCredentialOverrides();
const config = loadWorkerConfig();
if (config.execution.kind === "docker" || config.harborEnvironment === "docker") {
  await runCommand("docker", ["info"], { timeoutMs: 30_000 });
  await runCommand("docker", ["compose", "version"], { timeoutMs: 30_000 });
}
if (config.execution.kind === "e2b") {
  await validateE2BWorkerStartup(config.execution);
}
const connection = await connectTemporalWorker(config.temporal);
const credentials = await openWorkerRecords();
const workflowsPath = fileURLToPath(new URL("./workflow.js", import.meta.url));
const { compileAndVerify, ...sandboxActivities } = createActivities(
  config,
  credentials?.records,
  credentials ? createUsageStore(credentials.db) : undefined,
);
const { executeSolverEvaluation, ...evaluationActivities } = createEvaluationActivities(
  createArtifactStore(config.artifact),
  credentials?.records,
);
// Sandbox-driving activities are cheap for the worker; each Harbor activity hosts a ~300 MiB
// Python client, so new workflows schedule those on a sibling queue whose slots are sized to
// memory. Activity retries stay on the queue recorded in history, so the ordinary worker keeps
// them registered for workflows that scheduled a Harbor activity before this split was deployed.
const harborActivities = { compileAndVerify, executeSolverEvaluation };
const harborConcurrency = resolveHarborConcurrency(config.harborConcurrency);
const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.taskQueue,
  workflowsPath,
  activities: { ...sandboxActivities, ...evaluationActivities, ...harborActivities },
  maxConcurrentActivityTaskExecutions: config.activityConcurrency,
  interceptors: { activity: [activityEventInterceptor()] },
});
const harborWorker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: harborTaskQueue(config.temporal.taskQueue),
  activities: harborActivities,
  maxConcurrentActivityTaskExecutions: harborConcurrency,
});
console.log(
  `SelfBench worker polling ${config.temporal.namespace}/${config.temporal.taskQueue} with activity concurrency ${config.activityConcurrency} and Harbor concurrency ${harborConcurrency}`,
);
try {
  await Promise.all([worker.run(), harborWorker.run()]);
} finally {
  await credentials?.close();
}
