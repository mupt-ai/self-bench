import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { User } from "../../db/users.js";
import { addSteeringNote, listSteeringNotes } from "../../generation/pipeline/steering.js";
import { MAX_FEEDBACK_LENGTH } from "../../generation/tasks/feedback-limit.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { PullRequestRoutesOptions } from "./pull-requests.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/([a-z0-9][a-z0-9-]{2,62})\/([A-Za-z0-9][A-Za-z0-9._-]*)\/steering$/;

const bodySchema = z.object({ feedback: z.string().trim().min(1).max(MAX_FEEDBACK_LENGTH) });

/**
 * GET …/tasks/<run>/<task>/steering lists the notes sent to a task's author, and POST
 * {feedback} queues one while the task is still being generated. The author receives it at the
 * start of its next authoring turn (pipeline/steering.ts); a finished task is revised instead.
 */
export async function taskSteeringRoute(
  options: PullRequestRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match || (request.method !== "GET" && request.method !== "POST")) return false;
  const [, org = "", owner, name, runId = "", taskId = ""] = match;
  const posting = request.method === "POST";
  if (posting && options.publicUrl && !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
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
  const where = { runId: task.runId, candidateId: task.candidateId };
  if (!posting) {
    sendJson(response, 200, { notes: await listSteeringNotes(options.artifacts, where) });
    return true;
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse((await readBody(request, 64 * 1024)).toString("utf8")));
  } catch {
    sendJson(response, 400, {
      error: `Write your note, in at most ${MAX_FEEDBACK_LENGTH.toLocaleString("en-US")} characters.`,
    });
    return true;
  }
  if (task.pipelineStatus !== "in_progress") {
    sendJson(response, 409, {
      error: "This task's generation has finished. Revise the task to send it feedback.",
    });
    return true;
  }
  const note = await addSteeringNote(options.artifacts, where, {
    feedback: body.feedback,
    author: user.login,
  });
  sendJson(response, 201, { note });
  return true;
}
