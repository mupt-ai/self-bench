import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { User } from "../../db/users.js";
import { saveGenerationRecords } from "../../generation/settings/credentials.js";
import { MAX_FEEDBACK_LENGTH } from "../../generation/tasks/feedback-limit.js";
import { stageRevisionDraft, submittedDraft } from "../../generation/tasks/revision.js";
import { startTaskFromPullRequest, taskRevisionRunId } from "../../generation/tasks/start.js";
import { generationProperties, track } from "../../lib/telemetry/posthog.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import {
  candidateFromPullRequest,
  PullRequestError,
} from "../../third_party/github/pr-candidate.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { requestedGeneration } from "./generation-request.js";
import type { PullRequestRoutesOptions } from "./pull-requests.js";
import { taskItem } from "./tasks.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/([a-z0-9][a-z0-9-]{2,62})\/([A-Za-z0-9][A-Za-z0-9._-]*)\/feedback$/;
const COMMIT = /^[0-9a-f]{40}$/i;

const bodySchema = z.object({
  feedback: z.string().trim().min(1).max(MAX_FEEDBACK_LENGTH),
  generation: z.unknown().optional(),
});

/**
 * POST …/tasks/<run>/<task>/feedback {feedback, generation}: a person's feedback revises a
 * finished task. The revision is a new task of the same PR, started like one from Add PRs, whose
 * agent begins from the task's last submitted draft with the feedback; the task itself, and the
 * evaluations that ran it, stay as they are.
 */
export async function taskFeedbackRoute(
  options: PullRequestRoutesOptions & { readonly fetchImpl: typeof fetch },
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match || request.method !== "POST") return false;
  const [, org = "", owner, name, runId = "", taskId = ""] = match;
  if (options.publicUrl && !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
  const { users, repos, tasks, artifacts } = options;
  const tenant = await tenantFor(users, user, org);
  const repo = tenant ? await repos.find(tenant.id, `${owner}/${name}`) : undefined;
  if (!repo || !tenant) {
    sendJson(response, 404, { error: "repository is not connected here" });
    return true;
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse((await readBody(request, 64 * 1024)).toString("utf8")));
  } catch {
    sendJson(response, 400, {
      error: `Write your feedback, in at most ${MAX_FEEDBACK_LENGTH.toLocaleString("en-US")} characters.`,
    });
    return true;
  }
  const task = await tasks.find(repo.id, runId, taskId);
  if (!task) {
    sendJson(response, 404, { error: "task not found" });
    return true;
  }
  if (task.pipelineStatus === "in_progress") {
    sendJson(response, 409, { error: "Wait for this task's generation to finish." });
    return true;
  }
  if (task.sourcePr === undefined) {
    sendJson(response, 409, { error: "Only a task built from a pull request can be revised." });
    return true;
  }
  const draft = await submittedDraft(artifacts, task.runId, task.candidateId);
  if (!draft) {
    sendJson(response, 409, { error: "This task never submitted a draft to revise." });
    return true;
  }
  const requested = await requestedGeneration(
    options,
    { orgId: tenant.id, repoId: repo.id },
    body.generation,
  );
  if ("status" in requested) {
    sendJson(response, requested.status, requested.body);
    return true;
  }
  const { generation } = requested;
  const token = await users.gitHubToken(user.githubId);
  if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
  let pullRequest: Awaited<ReturnType<typeof candidateFromPullRequest>>;
  try {
    pullRequest = await candidateFromPullRequest(
      options.auth,
      token,
      repo.fullName,
      task.sourcePr,
      options.fetchImpl,
    );
  } catch (error) {
    if (!(error instanceof PullRequestError)) throw error;
    sendJson(response, error.status, { error: error.message });
    return true;
  }
  // The revision keeps the task's identity: the candidate, tier, and base it was authored from.
  const baseCommit = task.definition?.baseCommit;
  const provenance = await artifacts
    .getByKey(`runs/${task.runId}/provenance/${task.candidateId}.json`)
    .catch(() => undefined);
  let originalRequest: string | undefined;
  if (provenance) {
    try {
      const parsed = JSON.parse(Buffer.from(provenance).toString("utf8")) as {
        messages?: { content?: unknown }[];
      };
      const content = parsed.messages?.[0]?.content;
      if (typeof content === "string" && content.trim()) originalRequest = content;
    } catch {
      // Older or malformed provenance falls back to the current PR text.
    }
  }
  const candidate = {
    ...pullRequest.candidate,
    candidateId: task.candidateId,
    difficulty: task.difficulty,
    ...(originalRequest ? { request: originalRequest } : {}),
    ...(typeof baseCommit === "string" && COMMIT.test(baseCommit)
      ? { baseCommit: baseCommit.toLowerCase() }
      : {}),
  };
  const base = taskRevisionRunId(repo.fullName, task.sourcePr);
  const row = await tasks.reserveStarted({
    repoId: repo.id,
    runId: base,
    candidateId: task.candidateId,
    taskId: task.taskId,
    sourcePr: task.sourcePr,
    sourceUrl: candidate.sourceUrl,
    difficulty: task.difficulty,
    stage: "authoring",
    startedBy: user.id,
    revision: { from: task.id, feedback: body.feedback },
  });
  await startTaskFromPullRequest({
    config: options.config,
    artifacts,
    start: async (workflowId, input) => {
      if (generation && options.vault)
        await saveGenerationRecords(options.vault.records, row.runId, generation, token);
      await options.start(workflowId, input);
    },
    repository: repo,
    pullRequest: {
      ...pullRequest,
      candidate,
      ...(originalRequest ? { message: { ...pullRequest.message, content: originalRequest } } : {}),
    },
    attempt: 1,
    runId: row.runId,
    ...(generation ? { generation } : {}),
    revision: {
      draft: await stageRevisionDraft(artifacts, row.runId, draft),
      feedback: body.feedback,
    },
  });
  track(
    user,
    "task revision started",
    generation ? generationProperties(generation.settings) : {},
    tenant,
  );
  sendJson(response, 201, { task: taskItem(row) });
  return true;
}
