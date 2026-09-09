import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts.js";
import { loadConfig } from "../config.js";
import { connectTemporalWorker } from "../temporal/connection.js";
import { createEvaluationActivities } from "./activities.js";
import { openWorkerRecords } from "./worker-records.js";

const config = loadConfig();
const connection = await connectTemporalWorker(config.temporal);
const credentials = await openWorkerRecords();
const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: process.env.SELFBENCH_EVAL_TASK_QUEUE ?? "selfbench-evaluations",
  workflowsPath: fileURLToPath(new URL("./workflow.js", import.meta.url)),
  activities: createEvaluationActivities(
    createArtifactStore(config.artifact),
    credentials?.records,
  ),
  maxConcurrentActivityTaskExecutions: 1,
});
console.log("Evaluation worker ready; waiting for explicit Run submissions");
try {
  await worker.run();
} finally {
  await credentials?.close();
}
