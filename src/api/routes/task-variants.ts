import type { IncomingMessage, ServerResponse } from "node:http";
import type { VariantItem, VariantState } from "../../contracts/variants.js";
import type { TaskVariantRecord } from "../../db/task-variants.js";
import type { TaskRecord } from "../../db/tasks.js";
import type { User } from "../../db/users.js";
import { submittedDraft } from "../../generation/tasks/revision.js";
import { stageVariantDraft, variantRequestSchema } from "../../generation/tasks/variant.js";
import { generationProperties, track } from "../../lib/telemetry/posthog.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { requestedGeneration } from "./generation-request.js";
import { type RevisionRouteOptions, startRevision } from "./task-feedback.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/([a-z0-9][a-z0-9-]{2,62})\/([A-Za-z0-9][A-Za-z0-9._-]*)\/variants(?:\/([a-z0-9][a-z0-9-]{2,80})(?:\/(cancel))?)?$/;

/**
 * A task's variants (generation/tasks/variant.ts), kept apart from tasks:
 *
 * - `GET …/tasks/<run>/<task>/variants`: the task's variants, oldest first.
 * - `POST …/tasks/<run>/<task>/variants {variant, generation}`: starts one on an accepted task. Its
 *   draft is the task's own with only its environment changed; no author runs, so it is checked
 *   once and accepted if it passes.
 * - `POST …/variants/<variantRun>/cancel`: stops one still being checked.
 * - `DELETE …/variants/<variantRun>`: removes a settled one; its trials leave current results.
 */
export async function taskVariantsRoute(
  options: RevisionRouteOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match) return false;
  const [, org = "", owner, name, runId = "", taskId = "", variantRun, action] = match;
  const method = request.method ?? "GET";
  const listing = !variantRun && (method === "GET" || method === "POST");
  const one = variantRun && ((action && method === "POST") || (!action && method === "DELETE"));
  if (!listing && !one) return false;
  if (method !== "GET" && options.publicUrl && !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
  const { users, repos, tasks } = options;
  const tenant = await tenantFor(users, user, org);
  const repo = tenant ? await repos.find(tenant.id, `${owner}/${name}`) : undefined;
  if (!repo || !tenant) {
    sendJson(response, 404, { error: "repository is not connected here" });
    return true;
  }
  const task = await tasks.find(repo.id, runId, taskId);
  if (!task) {
    sendJson(response, 404, { error: "task not found" });
    return true;
  }
  if (variantRun) {
    const variant = await tasks.variants.find(repo.id, variantRun);
    if (!variant || variant.parentId !== task.id) {
      sendJson(response, 404, { error: "variant not found" });
      return true;
    }
    if (action === "cancel") {
      if (variant.pipelineStatus !== "in_progress") {
        sendJson(response, 200, {
          state: variant.stage === "cancelled" ? "confirmed" : "finished",
        });
        return true;
      }
      if (!variant.workflowId || !options.workflows) {
        sendJson(response, 409, { error: "Cancellation is unavailable for this variant." });
        return true;
      }
      await options.workflows.cancel(variant.workflowId);
      sendJson(response, 202, { state: "requested" });
      return true;
    }
    const result = await tasks.variants.delete(repo.id, variantRun);
    if (result === "active") {
      sendJson(response, 409, { error: "Stop this variant's check before deleting it." });
      return true;
    }
    sendJson(response, 200, { deleted: result !== "missing" });
    return true;
  }
  if (method === "GET") {
    const variants = await tasks.variants.listForTask(task.id);
    sendJson(response, 200, { variants: variants.map((variant) => variantItem(variant, task)) });
    return true;
  }
  return await createVariant(options, request, response, user, { tenant, repo, task });
}

async function createVariant(
  options: RevisionRouteOptions,
  request: IncomingMessage,
  response: ServerResponse,
  user: User,
  scope: {
    tenant: NonNullable<Awaited<ReturnType<typeof tenantFor>>>;
    repo: NonNullable<Awaited<ReturnType<RevisionRouteOptions["repos"]["find"]>>>;
    task: TaskRecord;
  },
): Promise<boolean> {
  const { tenant, repo, task } = scope;
  let raw: unknown;
  try {
    raw = JSON.parse((await readBody(request, 1024 * 1024)).toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Send the variant as JSON." });
    return true;
  }
  const parsed = variantRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendJson(response, 400, {
      error: issue ? `${issue.path.join(".") || "variant"}: ${issue.message}` : "Invalid variant",
    });
    return true;
  }
  const { variant: condition, generation: requestedSettings } = parsed.data;
  // A variant is compared with the task it changes, so that task must have passed its checks.
  if (task.pipelineStatus !== "accepted") {
    sendJson(response, 409, { error: "Only an accepted task can have a variant." });
    return true;
  }
  if (task.sourcePr === undefined && task.title === undefined) {
    sendJson(response, 409, {
      error: "Only a task built from a pull request or a scenario can have a variant.",
    });
    return true;
  }
  const submitted = await submittedDraft(options.artifacts, task);
  if (!submitted) {
    sendJson(response, 409, { error: "This task never submitted a draft to change." });
    return true;
  }
  const requested = await requestedGeneration(
    options,
    { orgId: tenant.id, repoId: repo.id },
    requestedSettings,
  );
  if ("status" in requested) {
    sendJson(response, requested.status, requested.body);
    return true;
  }
  const { generation } = requested;
  const changes = { packages: condition.packages, files: condition.files };
  const started = await startRevision(options, {
    repo,
    task,
    user,
    feedback: `Variant: ${condition.label}`,
    verifyOnly: true,
    // The variant's own run holds its changed draft, so it never depends on the task's.
    stage: (variantRunId) =>
      stageVariantDraft(options.artifacts, variantRunId, submitted, condition),
    reserve: (row) =>
      options.tasks.variants.reserve({
        parentId: task.id,
        repoId: repo.id,
        label: condition.label,
        changes,
        runId: row.runId,
        candidateId: row.candidateId,
        taskId: row.taskId,
        startedBy: row.startedBy,
      }),
    ...(generation ? { generation } : {}),
  });
  if ("status" in started) {
    sendJson(response, started.status, { error: started.error });
    return true;
  }
  track(
    user,
    "task variant started",
    {
      ...(generation ? generationProperties(generation.settings) : {}),
      source: task.sourcePr === undefined ? "scenario" : "pull_request",
      packages: String(changes.packages.length),
      files: String(changes.files.length),
    },
    tenant,
  );
  sendJson(response, 201, { variant: variantItem(started.row, task) });
  return true;
}

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

function variantItem(
  variant: TaskVariantRecord,
  task: Pick<TaskRecord, "runId" | "taskId">,
): VariantItem {
  const { reason } = variant;
  return {
    runId: variant.runId,
    taskId: variant.taskId,
    label: variant.label,
    ...(variant.changes ? { changes: variant.changes } : {}),
    state: variantState(variant),
    stage: variant.stage,
    ...(reason ? { reason, reasonSummary: reason.split("\n")[0]?.slice(0, 240) ?? reason } : {}),
    ...(variant.startedBy ? { startedBy: variant.startedBy } : {}),
    ...(variant.startedAt ? { startedAt: variant.startedAt } : {}),
    syncedAt: variant.syncedAt,
    of: { runId: task.runId, taskId: task.taskId },
  };
}
