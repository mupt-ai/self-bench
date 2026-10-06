import type { IncomingMessage, ServerResponse } from "node:http";
import { RecordStoreError } from "../../db/encrypted-records.js";
import {
  type GroupEvaluationRecord,
  type RepoGroup,
  repoGroupSchema,
} from "../../db/repo-groups.js";
import { runnable } from "../../db/task-record.js";
import type { User } from "../../db/users.js";
import {
  cancelGroupEvaluation,
  createGroupEvaluation,
  dispatchGroupEvaluation,
  groupEvaluationDetail,
  groupEvaluationSchema,
  groupEvaluationSettings,
} from "../../evaluation/group-evaluations.js";
import { managedOffer } from "../../generation/billing/managed.js";
import { track } from "../../lib/telemetry/posthog.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { catalogOf, type EvaluationRoutesOptions } from "./evaluations.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/groups(?:\/(catalog)|\/([a-f0-9-]{36})(?:\/(evaluations)(?:\/([a-f0-9-]{36})(?:\/(resume|cancel))?)?)?)?$/;

/**
 * Repository groups: a named set of the tenant's connected repositories, and evaluations that
 * run the same settings on each of them, as one comparison per repository.
 */
export async function groupRoutes(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
) {
  const match = pattern.exec(url.pathname);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  const tenant = await tenantFor(options.users, user, match[1] ?? "");
  if (!tenant) {
    sendJson(response, 404, { error: "Organization not found" });
    return true;
  }
  const { method = "GET" } = request;
  if (method !== "GET" && !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
  const [catalog, groupId, evaluationsPath, evaluationId, action] = match.slice(2);
  const body = async () => JSON.parse((await readBody(request, 30_000)).toString() || "{}");
  try {
    if (!options.vault || !options.groups) throw new RecordStoreError(503);
    const { groups } = options;
    const { comparisons } = options.vault;
    const { artifacts } = options;
    // Members are named as the repository routes name them; each must be connected here.
    const repoIds = async (names: string[]) =>
      Promise.all(
        names.map(async (name) => {
          const repo = await options.repos.find(tenant.id, name);
          if (!repo) throw new Error(`${name} is not connected here`);
          return repo.id;
        }),
      );
    if (catalog) {
      if (method === "GET") sendJson(response, 200, catalogOf(options.env ?? process.env));
      else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    if (!groupId) {
      if (method === "GET")
        sendJson(response, 200, { groups: (await groups.list(tenant.id)).map(groupItem) });
      else if (method === "POST") {
        const draft = repoGroupSchema.parse(await body());
        const group = await groups.create(tenant.id, draft.name, await repoIds(draft.repos));
        sendJson(response, 201, { group: groupItem(group) });
      } else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const group = await groups.find(tenant.id, groupId);
    if (!group) {
      sendJson(response, 404, { error: "Group not found" });
      return true;
    }
    const submitted = async (record: GroupEvaluationRecord, message: string) => {
      let submissionError: string | undefined;
      try {
        await dispatchGroupEvaluation(artifacts, comparisons, record, options.start);
      } catch {
        submissionError = message;
      }
      sendJson(response, 202, {
        ...(await groupEvaluationDetail(artifacts, comparisons, record)),
        submissionError,
      });
      return !submissionError;
    };
    if (!evaluationsPath) {
      if (method === "GET") {
        const ready = await Promise.all(
          group.repos.map(async (repo) => ({
            fullName: repo.fullName,
            approvedTasks: (await options.tasks.listForRepo(repo.id)).filter(runnable).length,
          })),
        );
        const evaluations = await groups.listEvaluations(tenant.id, group.id);
        sendJson(response, 200, {
          group: { ...groupItem(group), repos: ready },
          evaluations: evaluations.map((record) => ({
            id: record.id,
            createdAt: record.createdAt,
            createdBy: record.createdByLogin,
            settings: groupEvaluationSettings(record),
            repos: record.repos.length,
          })),
        });
      } else if (method === "PUT") {
        const draft = repoGroupSchema.parse(await body());
        const updated = await groups.update(
          tenant.id,
          group.id,
          draft.name,
          await repoIds(draft.repos),
        );
        if (updated) sendJson(response, 200, { group: groupItem(updated) });
        else sendJson(response, 404, { error: "Group not found" });
      } else if (method === "DELETE") {
        await groups.remove(tenant.id, group.id);
        sendJson(response, 200, { ok: true });
      } else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    if (!evaluationId) {
      if (method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      const draft = groupEvaluationSchema.parse(await body());
      const env = options.env ?? process.env;
      const record = await createGroupEvaluation(
        options.vault,
        groups,
        options.tasks,
        artifacts,
        managedOffer(env),
        { orgId: tenant.id, tenant: tenant.login, login: user.login },
        group,
        draft,
        env,
      );
      const confirmed = await submitted(
        record,
        "Group evaluation saved. Some submissions were not confirmed; resume safely using this evaluation.",
      );
      track(
        user,
        "group evaluation started",
        {
          repos: group.repos.length,
          models: draft.models.length,
          harnesses: draft.models.reduce((sum, model) => sum + model.harnesses.length, 0),
          sandbox: draft.sandbox,
          submitted: confirmed,
        },
        tenant,
      );
      return true;
    }
    const record = await groups.findEvaluation(evaluationId);
    if (!record || record.orgId !== tenant.id || record.groupId !== group.id)
      sendJson(response, 404, { error: "Group evaluation not found" });
    else if (method === "GET" && !action)
      sendJson(response, 200, await groupEvaluationDetail(artifacts, comparisons, record));
    else if (method === "POST" && action === "resume")
      await submitted(record, "Submission not confirmed. Resume uses the same run IDs.");
    else if (method === "POST" && action === "cancel") {
      await cancelGroupEvaluation(artifacts, comparisons, record, user.login, options.stop);
      sendJson(response, 200, await groupEvaluationDetail(artifacts, comparisons, record));
    } else sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    if (error instanceof RecordStoreError)
      sendJson(response, error.status, { error: error.message });
    else
      sendJson(response, 400, {
        error:
          error instanceof Error && error.name !== "ZodError"
            ? error.message
            : "Invalid group or evaluation fields",
      });
  } finally {
    request.resume();
  }
  return true;
}

/** The browser-facing shape of a group: its members by name. */
function groupItem(group: RepoGroup) {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    repos: group.repos.map((repo) => repo.fullName),
  };
}
