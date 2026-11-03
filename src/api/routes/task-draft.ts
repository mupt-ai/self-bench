import type { IncomingMessage, ServerResponse } from "node:http";
import type { User } from "../../db/users.js";
import { submittedDraft } from "../../generation/tasks/revision.js";
import { tenantFor } from "../auth/tenant.js";
import { sendJson } from "../http.js";
import type { PullRequestRoutesOptions } from "./pull-requests.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/([a-z0-9][a-z0-9-]{2,62})\/([A-Za-z0-9][A-Za-z0-9._-]*)\/draft$/;

/**
 * GET …/tasks/<run>/<task>/draft: the author's files the task last submitted (instruction.md,
 * Dockerfile, the patches, scripts, and a scenario's workspace/) as one tar.gz. It is what a
 * revision starts from, so a person can edit it and send it back with their feedback.
 */
export async function taskDraftRoute(
  options: Pick<PullRequestRoutesOptions, "users" | "repos" | "tasks" | "artifacts">,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match || request.method !== "GET") return false;
  const [, org = "", owner, name, runId = "", taskId = ""] = match;
  const tenant = await tenantFor(options.users, user, org);
  const repo = tenant ? await options.repos.find(tenant.id, `${owner}/${name}`) : undefined;
  if (!repo) {
    sendJson(response, 404, { error: "repository is not connected here" });
    return true;
  }
  const task = await options.tasks.find(repo.id, runId, taskId);
  if (!task) {
    sendJson(response, 404, { error: "task not found" });
    return true;
  }
  const draft = await submittedDraft(options.artifacts, task);
  if (!draft) {
    sendJson(response, 404, { error: "This task has not submitted a draft yet." });
    return true;
  }
  const bytes = await options.artifacts.get(draft.sourceBundle);
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": String(bytes.byteLength),
    "content-disposition": `attachment; filename="${task.taskId}.tar.gz"`,
    "cache-control": "no-store",
    "x-content-sha256": draft.sourceBundle.sha256,
  });
  response.end(bytes);
  return true;
}
