import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../contracts/config/index.js";
import { connectTemporalWorker } from "../temporal/connection.js";
import { harborTaskQueue } from "../temporal/task-queues.js";
import { createEvaluationActivities } from "./activities.js";
import { openWorkerRecords } from "./worker-records.js";

const config = loadConfig();
const connection = await connectTemporalWorker(config.temporal);
const credentials = await openWorkerRecords();
const taskQueue = process.env.SELFBENCH_EVAL_TASK_QUEUE ?? "selfbench-evaluations";
const { executeSolverEvaluation, ...activities } = createEvaluationActivities(
  createArtifactStore(config.artifact),
  credentials?.records,
);
// Solver trials spawn `harbor run`; new workflows schedule them on the sibling queue. Retries
// stay on the queue in history, so pre-split evaluations still complete here.
const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL("./workflow.js", import.meta.url)),
  activities: { ...activities, executeSolverEvaluation },
  maxConcurrentActivityTaskExecutions: 1,
});
const harborWorker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: harborTaskQueue(taskQueue),
  activities: { executeSolverEvaluation },
  maxConcurrentActivityTaskExecutions: 1,
});
console.log("Evaluation worker ready; waiting for explicit Run submissions");
try {
  await Promise.all([worker.run(), harborWorker.run()]);
} finally {
  await credentials?.close();
}
