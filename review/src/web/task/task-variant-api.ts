import type { VariantItem } from "../../../../src/contracts/variants";
import type { TaskResults } from "../../../../src/evaluation/results-report";
import type { GenerationSettings } from "../../../../src/generation/settings/settings";
import { repoPath, requestJson } from "../api";
import { evaluationRequest, evaluationUrl } from "../evaluation/api";

export type { VariantItem };

/** What a variant changes in an accepted task's environment (generation/tasks/variant.ts). */
export interface VariantInput {
  label: string;
  packages: { name: string; spec: string; directory: string }[];
  files: { path: string; mode: "replace" | "append"; content: string }[];
}

type TaskRef = { runId: string; taskId: string };

const variantsPath = (org: string, fullName: string, task: TaskRef) =>
  `${repoPath(org, fullName)}/tasks/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.taskId)}/variants`;

/** Starts a variant: the task with only its environment changed, checked once, never re-authored. */
export async function createTaskVariant(
  org: string,
  fullName: string,
  task: TaskRef,
  variant: VariantInput,
  generation?: GenerationSettings,
): Promise<VariantItem> {
  const body = await requestJson<{ variant: VariantItem }>(variantsPath(org, fullName, task), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ variant, ...(generation ? { generation } : {}) }),
  });
  return body.variant;
}

export async function listTaskVariants(
  org: string,
  fullName: string,
  task: TaskRef,
): Promise<VariantItem[]> {
  return (await requestJson<{ variants: VariantItem[] }>(variantsPath(org, fullName, task)))
    .variants;
}

/** Stops a variant still being checked, or removes a settled one. */
export async function endTaskVariant(
  org: string,
  fullName: string,
  task: TaskRef,
  variantRun: string,
  action: "cancel" | "delete",
): Promise<void> {
  const path = `${variantsPath(org, fullName, task)}/${encodeURIComponent(variantRun)}`;
  await requestJson(
    action === "cancel" ? `${path}/cancel` : path,
    action === "cancel" ? { method: "POST" } : { method: "DELETE" },
  );
}

/** The task's and its variants' latest scored result per configuration, as Results reports them. */
export interface VariantComparison {
  configurations: { key: string; name: string }[];
  task?: TaskResults;
  variants: (TaskResults & { label: string })[];
}

export async function variantComparison(
  org: string,
  fullName: string,
  task: TaskRef,
): Promise<VariantComparison> {
  const query = new URLSearchParams(task);
  const report = await evaluationRequest<{
    configurations: { key: string; name: string }[];
    taskResults: TaskResults[];
    variants?: (TaskResults & { label: string })[];
  }>(`${evaluationUrl(org, fullName)}/results?${query}`);
  return {
    configurations: report.configurations,
    ...(report.taskResults[0] ? { task: report.taskResults[0] } : {}),
    variants: report.variants ?? [],
  };
}

/** The Run page with the task and its accepted variants picked, so one comparison runs them alike. */
export function runVariantsPath(fullName: string, task: TaskRef, variants: VariantItem[]): string {
  const tasks = [
    task,
    ...variants
      .filter((variant) => variant.state === "accepted")
      .map(({ runId, taskId }) => ({ runId, taskId })),
  ];
  return `/repos/${fullName}/run?${new URLSearchParams({ tasks: JSON.stringify(tasks) })}`;
}
