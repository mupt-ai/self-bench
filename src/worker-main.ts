import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createActivities } from "./activities.js";
import { loadConfig } from "./config.js";
import { removeEmptyModalCredentialOverrides } from "./modal-auth.js";
import { runCommand } from "./process.js";
import { connectTemporalWorker } from "./temporal.js";

removeEmptyModalCredentialOverrides();
const config = loadConfig();
if (config.execution.kind === "docker" || config.harborEnvironment === "docker") {
  await runCommand("docker", ["info"], { timeoutMs: 30_000 });
  await runCommand("docker", ["compose", "version"], { timeoutMs: 30_000 });
}
const connection = await connectTemporalWorker(config.temporal);
const javascriptWorkflow = fileURLToPath(new URL("./workflow.js", import.meta.url));
const workflowsPath = existsSync(javascriptWorkflow)
  ? javascriptWorkflow
  : fileURLToPath(new URL("./workflow.ts", import.meta.url));
const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.taskQueue,
  workflowsPath,
  activities: createActivities(config),
  maxConcurrentActivityTaskExecutions: config.activityConcurrency,
});
console.log(
  `SelfBench worker polling ${config.temporal.namespace}/${config.temporal.taskQueue} with activity concurrency ${config.activityConcurrency}`,
);
await worker.run();
