import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTaskDraft } from "../../contracts/index.js";
import type { TaskRecord } from "../../db/tasks.js";
import type { User } from "../../db/users.js";
import { saveGenerationRecords } from "../../generation/settings/credentials.js";
import { MAX_FEEDBACK_LENGTH } from "../../generation/tasks/feedback-limit.js";
import { stageRevisionDraft, submittedDraft } from "../../generation/tasks/revision.js";
import { reviseScenario } from "../../generation/tasks/scenario-revision.js";
import { startTaskFromPullRequest, taskRevisionRunId } from "../../generation/tasks/start.js";
import {
  MAX_DRAFT_BYTES,
  stageUploadedDraft,
  uploadedDraftProblems,
} from "../../generation/tasks/uploaded-draft.js";
import {
  stageVariantDraft,
  type VariantCondition,
  variantRequestSchema,
} from "../../generation/tasks/variant.js";
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
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/([a-z0-9][a-z0-9-]{2,62})\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(feedback|variants)$/;

const bodySchema = z.object({
  feedback: z.string().trim().min(1).max(MAX_FEEDBACK_LENGTH),
  generation: z.unknown().optional(),
  /** The task's files as GET …/draft gives them, base64, edited by the person. */
  draft: z.base64().optional(),
});

const BODY_LIMIT = Math.ceil((MAX_DRAFT_BYTES * 4) / 3) + 64 * 1024;

type Options = PullRequestRoutesOptions & { readonly fetchImpl: typeof fetch };

/**
 * POST …/tasks/<run>/<task>/feedback {feedback, generation, draft?}: a person's feedback revises
 * a finished task. The revision is a new task of the same PR or scenario, started like one from
 * Add PRs, whose agent begins from the task's last submitted draft, or from the edited draft the
 * person sent, with the feedback; the task itself, and the evaluations that ran it, stay as they are.
 *
 * POST …/tasks/<run>/<task>/variants {variant, generation}: an accepted task's variant, a revision
 * whose draft is the task's own with only its environment changed (packages installed over its
 * own, files written into /app). No author runs: it is checked once and accepted if it passes, so
 * its instruction and tests stay the original's and the two can be compared.
 */
export async function taskFeedbackRoute(
  options: Options,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match || request.method !== "POST") return false;
  const [, org = "", owner, name, runId = "", taskId = "", action] = match;
  const variantRequest = action === "variants";
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
  let condition: VariantCondition | undefined;
  try {
    const raw = JSON.parse((await readBody(request, BODY_LIMIT)).toString("utf8"));
    if (variantRequest) {
      const parsed = variantRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        sendJson(response, 400, {
          error: issue
            ? `${issue.path.join(".") || "variant"}: ${issue.message}`
            : "Invalid variant",
        });
        return true;
      }
      condition = parsed.data.variant;
      body = { feedback: `Variant: ${condition.label}`, generation: parsed.data.generation };
    } else body = bodySchema.parse(raw);
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
  // A variant is compared with the task it changes, so that task must have passed its checks.
  if (condition && task.pipelineStatus !== "accepted") {
    sendJson(response, 409, { error: "Only an accepted task can have a variant." });
    return true;
  }
  const scenario = task.sourcePr === undefined && task.title !== undefined;
  if (task.sourcePr === undefined && !scenario) {
    sendJson(response, 409, {
      error: "Only a task built from a pull request or a scenario can be revised.",
    });
    return true;
  }
  const uploaded = body.draft === undefined ? undefined : Buffer.from(body.draft, "base64");
  if (uploaded) {
    const problems = await uploadedDraftProblems(uploaded);
    if (problems.length > 0) {
      sendJson(response, 400, { error: problems.join("; ") });
      return true;
    }
  }
  const submitted = uploaded ? undefined : await submittedDraft(artifacts, task);
  if (!uploaded && !submitted) {
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
  // The revision's own run holds its starting draft, so it never depends on the original's.
  const stage = async (revisionRunId: string): Promise<AuthoredTaskDraft> =>
    uploaded
      ? await stageUploadedDraft(artifacts, revisionRunId, task, uploaded)
      : condition
        ? await stageVariantDraft(
            artifacts,
            revisionRunId,
            submitted as AuthoredTaskDraft,
            condition,
          )
        : await stageRevisionDraft(artifacts, revisionRunId, submitted as AuthoredTaskDraft);
  const revision = {
    from: task.id,
    feedback: body.feedback,
    ...(condition ? { variant: condition.label } : {}),
  };
  let row: TaskRecord;
  if (scenario) {
    // A repository scenario's run clones its commit with the person's token, as a PR's does.
    const token = task.baseCommit ? await options.users.gitHubToken(user.githubId) : undefined;
    row = await reviseScenario({
      ...options,
      repository: repo,
      task,
      startedBy: user.id,
      revision,
      stage,
      ...(generation ? { generation } : {}),
      ...(token ? { token } : {}),
    });
  } else {
    const started = await revisePullRequest(options, repo, task, user, revision, stage, generation);
    if ("status" in started) {
      sendJson(response, started.status, { error: started.error });
      return true;
    }
    row = started.row;
  }
  track(
    user,
    condition ? "task variant started" : "task revision started",
    {
      ...(generation ? generationProperties(generation.settings) : {}),
      source: scenario ? "scenario" : "pull_request",
      edited: uploaded !== undefined,
    },
    tenant,
  );
  sendJson(response, 201, { task: taskItem(row) });
  return true;
}

/** A PR task's revision: the PR read again with the person's token, on the task's own base. */
async function revisePullRequest(
  options: Options,
  repo: { readonly id: number; readonly fullName: string; readonly defaultBranch: string },
  task: TaskRecord,
  user: User,
  revision: { readonly from: number; readonly feedback: string; readonly variant?: string },
  stage: (runId: string) => Promise<AuthoredTaskDraft>,
  generation: Parameters<typeof saveGenerationRecords>[2] | undefined,
): Promise<{ row: TaskRecord } | { status: number; error: string }> {
  const sourcePr = task.sourcePr as number;
  const token = await options.users.gitHubToken(user.githubId);
  if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
  let pullRequest: Awaited<ReturnType<typeof candidateFromPullRequest>>;
  try {
    pullRequest = await candidateFromPullRequest(
      options.auth,
      token,
      repo.fullName,
      sourcePr,
      options.fetchImpl,
    );
  } catch (error) {
    if (!(error instanceof PullRequestError)) throw error;
    return { status: error.status, error: error.message };
  }
  // The revision keeps the task's identity: the candidate, tier, and base it was authored from.
  const originalRequest = await recordedRequest(options.artifacts, task);
  const candidate = {
    ...pullRequest.candidate,
    candidateId: task.candidateId,
    difficulty: task.difficulty,
    ...(originalRequest ? { request: originalRequest } : {}),
    ...(task.baseCommit ? { baseCommit: task.baseCommit } : {}),
  };
  const row = await options.tasks.reserveStarted({
    repoId: repo.id,
    runId: taskRevisionRunId(repo.fullName, sourcePr),
    candidateId: task.candidateId,
    taskId: task.taskId,
    sourcePr,
    sourceUrl: candidate.sourceUrl,
    baseCommit: candidate.baseCommit,
    difficulty: task.difficulty,
    stage: "authoring",
    startedBy: user.id,
    revision: { from: revision.from, feedback: revision.feedback },
    ...(revision.variant ? { variant: revision.variant } : {}),
  });
  await startTaskFromPullRequest({
    config: options.config,
    artifacts: options.artifacts,
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
      draft: await stage(row.runId),
      feedback: revision.feedback,
      ...(revision.variant ? { verifyOnly: true } : {}),
    },
  });
  return { row };
}

/** The request the task was first authored from, as its run's provenance recorded it. */
async function recordedRequest(
  artifacts: ArtifactStore,
  task: Pick<TaskRecord, "runId" | "candidateId">,
): Promise<string | undefined> {
  const provenance = await artifacts
    .getByKey(`runs/${task.runId}/provenance/${task.candidateId}.json`)
    .catch(() => undefined);
  if (!provenance) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(provenance).toString("utf8")) as {
      messages?: { content?: unknown }[];
    };
    const content = parsed.messages?.[0]?.content;
    return typeof content === "string" && content.trim() ? content : undefined;
  } catch {
    // Older or malformed provenance falls back to the current PR text.
    return undefined;
  }
}
