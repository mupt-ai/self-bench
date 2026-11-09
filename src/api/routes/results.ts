import type { ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { EvaluationDataset } from "../../evaluation/dataset.js";
import { summarizable } from "../../evaluation/model-summary.js";
import { resultsReport } from "../../evaluation/results-report.js";
import type { EvaluationScope } from "../../evaluation/scope.js";
import { listEvaluations } from "../../evaluation/store.js";
import { readTaskAudit } from "../../evaluation/task-audit.js";
import { sendJson } from "../http.js";

/**
 * `GET …/evaluations/results`: each configuration's score on the tasks results count on, and each
 * task's latest scored result per configuration with its failure explanation. `?runId=&taskId=`
 * narrows the tasks to one and adds its latest fairness audit.
 */
export async function resultsRoute(
  artifacts: ArtifactStore,
  url: URL,
  response: ServerResponse,
  scope: EvaluationScope,
  dataset: Pick<EvaluationDataset, "summaryTasks">,
): Promise<void> {
  const runId = url.searchParams.get("runId");
  const taskId = url.searchParams.get("taskId");
  const [runs, counted] = await Promise.all([
    listEvaluations(artifacts, scope),
    dataset.summaryTasks(),
  ]);
  const report = resultsReport(summarizable(runs, counted), counted);
  if (!runId || !taskId) {
    sendJson(response, 200, report);
    return;
  }
  const task = report.taskResults.find((entry) => entry.runId === runId && entry.taskId === taskId);
  if (!task) {
    sendJson(response, 404, { error: "Task not found among the tasks results count on" });
    return;
  }
  const { audit } = await readTaskAudit(artifacts, { ...scope, runId, taskId });
  sendJson(response, 200, { ...report, taskResults: [task], ...(audit ? { audit } : {}) });
}
