import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts.js";
import { loadWorkerConfig } from "../config.js";
import { createEvaluationActivities } from "../evaluation/activities.js";
import { openWorkerRecords } from "../evaluation/worker-records.js";
import { runCommand } from "../process.js";
import { validateE2BWorkerStartup } from "../sandbox/providers/e2b/startup.js";
import { removeEmptyModalCredentialOverrides } from "../sandbox/providers/modal/auth.js";
import { createActivities } from "./activities.js";
import { connectTemporalWorker } from "./connection.js";
import { createWorkerHealthServer } from "./worker-health.js";

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
const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.taskQueue,
  workflowsPath,
  // Leave time for cancellation/cleanup inside Compose's two-minute stop window.
  shutdownGraceTime: "90 seconds",
  activities: {
    ...createActivities(config, credentials?.records),
    ...createEvaluationActivities(createArtifactStore(config.artifact), credentials?.records),
  },
  maxConcurrentActivityTaskExecutions: config.activityConcurrency,
});
console.log(
  `SelfBench worker polling ${config.temporal.namespace}/${config.temporal.taskQueue} with activity concurrency ${config.activityConcurrency}`,
);
const health = createWorkerHealthServer(() => worker.getState());
health.listen(8081, "127.0.0.1");
try {
  await worker.run();
} finally {
  health.close();
  await credentials?.close();
}
