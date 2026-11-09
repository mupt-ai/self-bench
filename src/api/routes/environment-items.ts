import type {
  EnvironmentCoverage,
  EnvironmentItem,
  EnvironmentTaskItem,
  VariantState,
} from "../../contracts/variants.js";
import type { TaskEnvironmentRecord, TaskVariantRecord } from "../../db/task-variants.js";
import type { TaskRecord } from "../../db/tasks.js";

/** Environments and their tasks' checks as the API shows them (environments.ts). */

function variantState(variant: Pick<TaskVariantRecord, "pipelineStatus" | "stage">): VariantState {
  if (variant.stage === "cancelled") return "cancelled";
  switch (variant.pipelineStatus) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "infrastructure_failed":
      return "failed";
    default:
      return "in_progress";
  }
}

/** Each task's latest variant in the environment, by the task it changes. */
function latestByTask(environment: TaskEnvironmentRecord, variants: TaskVariantRecord[]) {
  const latest = new Map<number, TaskVariantRecord>();
  for (const variant of variants)
    if (variant.environmentId === environment.id) latest.set(variant.parentId, variant);
  return latest;
}

function coverageOf(variants: Iterable<TaskVariantRecord>): EnvironmentCoverage {
  const counts = { ready: 0, checking: 0, failed: 0, total: 0 };
  for (const variant of variants) {
    counts.total += 1;
    const state = variantState(variant);
    if (state === "accepted") counts.ready += 1;
    else if (state === "in_progress") counts.checking += 1;
    else counts.failed += 1;
  }
  return counts;
}

export function environmentItem(
  environment: TaskEnvironmentRecord,
  variants: TaskVariantRecord[],
): EnvironmentItem {
  return {
    id: environment.id,
    name: environment.name,
    ...(environment.changes ? { changes: environment.changes } : {}),
    ...(environment.createdBy ? { createdBy: environment.createdBy } : {}),
    createdAt: environment.createdAt,
    tasks: coverageOf(latestByTask(environment, variants).values()),
  };
}

export function environmentTasks(
  environment: TaskEnvironmentRecord,
  variants: TaskVariantRecord[],
  tasks: TaskRecord[],
): EnvironmentTaskItem[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return [...latestByTask(environment, variants).values()].flatMap((variant) => {
    const task = byId.get(variant.parentId);
    if (!task) return [];
    const reason = variant.reason?.split("\n")[0]?.slice(0, 240);
    return [
      {
        task: { runId: task.runId, taskId: task.taskId },
        runId: variant.runId,
        state: variantState(variant),
        ...(reason && variantState(variant) !== "accepted" ? { reasonSummary: reason } : {}),
      },
    ];
  });
}
