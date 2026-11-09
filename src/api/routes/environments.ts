import type { IncomingMessage, ServerResponse } from "node:http";
import { runnable } from "../../db/task-record.js";
import type { TaskVariantRecord } from "../../db/task-variants.js";
import type { User } from "../../db/users.js";
import { submittedDraft } from "../../generation/tasks/revision.js";
import {
  type EnvironmentSpec,
  environmentRequestSchema,
  stageVariantDraft,
  stopVariantChecks,
} from "../../generation/tasks/variant.js";
import { generationProperties, track } from "../../lib/telemetry/posthog.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { environmentItem, environmentTasks } from "./environment-items.js";
import { requestedGeneration } from "./generation-request.js";
import { type RevisionRouteOptions, startRevision } from "./task-feedback.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/environments(?:\/(\d{1,15})(?:\/(build))?)?$/;

/** At most this many variant checks start at once while an environment builds. */
const STARTING = 4;

/**
 * A repository's environments (task-variant-schema.ts): changes to every approved task's files,
 * each task built and checked once as a variant, so a run condition can run them all.
 *
 * - `GET {repo}/environments`: each environment and how many of its tasks are ready.
 * - `POST {repo}/environments {environment, generation}`: saves one and builds every approved task.
 * - `GET {repo}/environments/{id}`: one, with each task's check.
 * - `POST {repo}/environments/{id}/build {generation}`: builds the approved tasks it has none ready
 *   or checking for: tasks approved since, and ones whose check failed.
 * - `DELETE {repo}/environments/{id}`: removes it and its variants.
 */
export async function environmentsRoute(
  options: RevisionRouteOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match) return false;
  const [, org = "", owner, name, id, action] = match;
  const method = request.method ?? "GET";
  const allowed = id
    ? action
      ? method === "POST"
      : method === "GET" || method === "DELETE"
    : method === "GET" || method === "POST";
  if (!allowed) return false;
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
  const store = tasks.variants;
  if (!id && method === "GET") {
    const [environments, variants] = await Promise.all([
      store.listEnvironments(repo.id),
      store.listForRepo(repo.id),
    ]);
    sendJson(response, 200, {
      environments: environments.map((environment) => environmentItem(environment, variants)),
    });
    return true;
  }
  if (id && method === "DELETE") {
    // Deleted first, so no build starts a check after the stop below; repeating it retries the stop.
    if (!(await store.deleteEnvironment(repo.id, Number(id)))) {
      sendJson(response, 404, { error: "environment not found" });
      return true;
    }
    const running = await store.runningChecks(repo.id, { environmentId: Number(id) });
    const unstopped = await stopVariantChecks(running, options.workflows, store);
    if (unstopped > 0) {
      sendJson(response, 502, {
        error: `Deleted, but ${unstopped} running ${unstopped === 1 ? "check" : "checks"} did not stop. Delete it again to retry.`,
      });
      return true;
    }
    sendJson(response, 200, { deleted: true });
    return true;
  }
  const environment = id ? await store.findEnvironment(repo.id, Number(id)) : undefined;
  if (id && !environment) {
    sendJson(response, 404, { error: "environment not found" });
    return true;
  }
  if (environment && method === "GET") {
    const [variants, approved] = await Promise.all([
      store.listForRepo(repo.id),
      tasks.listForRepo(repo.id),
    ]);
    sendJson(response, 200, {
      environment: environmentItem(environment, variants),
      tasks: environmentTasks(environment, variants, approved),
    });
    return true;
  }
  // Creating one, or building one's missing tasks: both start checks with generation settings.
  let raw: Record<string, unknown>;
  try {
    const text = (await readBody(request, 1024 * 1024)).toString("utf8");
    raw = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    sendJson(response, 400, { error: "Send the environment as JSON." });
    return true;
  }
  let spec: EnvironmentSpec;
  if (environment) {
    if (!environment.changes) {
      sendJson(response, 409, { error: "This environment recorded no changes to build again." });
      return true;
    }
    spec = { name: environment.name, ...environment.changes } as EnvironmentSpec;
  } else {
    const parsed = environmentRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      sendJson(response, 400, {
        error: issue
          ? `${issue.path.join(".") || "environment"}: ${issue.message}`
          : "Invalid environment",
      });
      return true;
    }
    spec = parsed.data.environment;
  }
  const requested = await requestedGeneration(
    options,
    { orgId: tenant.id, repoId: repo.id },
    raw.generation,
  );
  if ("status" in requested) {
    sendJson(response, requested.status, requested.body);
    return true;
  }
  const { generation } = requested;
  const [approved, variants] = await Promise.all([
    tasks.listForRepo(repo.id).then((found) => found.filter(runnable)),
    store.listForRepo(repo.id),
  ]);
  // A task with a variant ready or still checking in this environment needs no other.
  const covered = new Set(
    variants
      .filter(
        (variant) =>
          variant.environmentId === environment?.id &&
          (variant.pipelineStatus === "in_progress" || variant.pipelineStatus === "accepted"),
      )
      .map((variant) => variant.parentId),
  );
  const pending = approved.filter(
    (task) => !covered.has(task.id) && (task.sourcePr !== undefined || task.title !== undefined),
  );
  if (pending.length === 0) {
    sendJson(response, 409, {
      error: environment
        ? "Every approved task is ready or being checked in this environment."
        : "Approve a task first: an environment builds every approved task.",
    });
    return true;
  }
  const saved =
    environment ??
    (await store.createEnvironment({
      repoId: repo.id,
      name: spec.name,
      changes: { packages: spec.packages, files: spec.files },
      createdBy: user.id,
    }));
  const changes = { name: saved.name, packages: spec.packages, files: spec.files };
  const failures: string[] = [];
  for (let at = 0; at < pending.length; at += STARTING) {
    await Promise.all(
      pending.slice(at, at + STARTING).map(async (task) => {
        const draft = await submittedDraft(options.artifacts, task);
        if (!draft) return failures.push(`${task.taskId}: never submitted a draft`);
        let reserved: TaskVariantRecord | undefined;
        const started = await startRevision(options, {
          repo,
          task,
          user,
          feedback: `Environment: ${saved.name}`,
          verifyOnly: true,
          // The variant's own run holds its changed draft, so it never depends on the task's.
          stage: (variantRunId) =>
            stageVariantDraft(options.artifacts, variantRunId, draft, changes),
          reserve: async (row) => {
            reserved = await store.reserve({
              environmentId: saved.id,
              parentId: task.id,
              repoId: repo.id,
              runId: row.runId,
              candidateId: row.candidateId,
              taskId: row.taskId,
              startedBy: row.startedBy,
            });
            return reserved;
          },
          ...(generation ? { generation } : {}),
        }).catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          // A build that never started settles as failed, so Build Missing Tasks tries it again.
          if (reserved)
            await store.settle(reserved.runId, reserved.candidateId, {
              pipelineStatus: "infrastructure_failed",
              stage: "verifying",
              reason: `The check could not start: ${message}`,
            });
          return { status: 500, error: message };
        });
        if ("status" in started) failures.push(`${task.taskId}: ${started.error}`);
      }),
    );
  }
  track(
    user,
    environment ? "environment rebuilt" : "environment created",
    {
      ...(generation ? generationProperties(generation.settings) : {}),
      tasks: String(pending.length),
      packages: String(spec.packages.length),
      files: String(spec.files.length),
    },
    tenant,
  );
  sendJson(response, environment ? 202 : 201, {
    environment: environmentItem(saved, await store.listForRepo(repo.id)),
    ...(failures.length ? { failures } : {}),
  });
  return true;
}
