import type { IncomingMessage, ServerResponse } from "node:http";
import { EVAL_OWNER } from "../../contracts/evals.js";
import type { User } from "../../db/users.js";
import { saveGenerationRecords } from "../../generation/settings/credentials.js";
import {
  SCENARIO_BODY_LIMIT,
  scenarioCandidateId,
  scenarioRequestSchema,
  scenarioRunId,
  stageScenario,
  startTaskFromScenario,
} from "../../generation/tasks/scenario-start.js";
import { generationProperties, track } from "../../lib/telemetry/posthog.js";
import { CommitNotFoundError, resolveCommit } from "../../third_party/github/commit.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { requestedGeneration } from "./generation-request.js";
import type { PullRequestRoutesOptions } from "./pull-requests.js";
import { taskItem } from "./tasks.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/from-scenario$/;

/**
 * POST …/tasks/from-scenario {title, scenario, difficulty?, attachments?, commit?, generation}: a
 * person's description of a change or situation an agent should handle becomes one task, built by
 * its own workflow as a PR from Add PRs is. With `commit`, the agent starts from the repository at
 * that commit (resolved with the person's GitHub token, which the run keeps to clone it); a
 * GitHub repository's scenario needs one. An eval's scenario has none: the author writes the
 * workspace and nothing is read from GitHub.
 */
export async function scenarioRoute(
  options: PullRequestRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match || request.method !== "POST") return false;
  const [, org = "", owner, name] = match;
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
  let raw: unknown;
  try {
    raw = JSON.parse((await readBody(request, SCENARIO_BODY_LIMIT)).toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Send the scenario as JSON." });
    return true;
  }
  const parsed = scenarioRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendJson(response, 400, {
      error: issue ? `${issue.path.join(".") || "scenario"}: ${issue.message}` : "Invalid scenario",
    });
    return true;
  }
  const body = parsed.data;
  // A GitHub repository's scenario starts from the repository at a commit; a scenario with no
  // repository behind it is a workspace scenario, which belongs to an eval.
  if (repo.kind === "eval" && body.commit) {
    sendJson(response, 400, { error: "An eval has no repository; leave out commit." });
    return true;
  }
  if (repo.kind === "github" && !body.commit) {
    sendJson(response, 400, {
      error: `Name the commit the agent starts from. A vibe eval with no repository behind it belongs to an eval (${EVAL_OWNER}/<name>).`,
    });
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
  let token: string | undefined;
  let baseCommit: string | undefined;
  if (body.commit) {
    token = await options.users.gitHubToken(user.githubId);
    if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
    try {
      baseCommit = await resolveCommit(
        options.auth,
        token,
        repo.fullName,
        body.commit,
        options.fetchImpl,
      );
    } catch (error) {
      if (!(error instanceof CommitNotFoundError)) throw error;
      sendJson(response, error.status, { error: error.message });
      return true;
    }
  }
  const candidateId = scenarioCandidateId(body.title);
  const row = await tasks.reserveStarted({
    repoId: repo.id,
    runId: scenarioRunId(repo.fullName),
    candidateId,
    taskId: candidateId,
    title: body.title,
    difficulty: body.difficulty,
    ...(baseCommit ? { baseCommit } : {}),
    stage: "authoring",
    startedBy: user.id,
  });
  const staged = await stageScenario({
    artifacts,
    runId: row.runId,
    candidateId,
    title: body.title,
    scenario: body.scenario,
    difficulty: body.difficulty,
    attachments: body.attachments,
    ...(baseCommit ? { baseCommit } : {}),
  });
  if (generation && options.vault)
    await saveGenerationRecords(options.vault.records, row.runId, generation, token);
  await startTaskFromScenario({
    config: options.config,
    start: options.start,
    repository: repo,
    runId: row.runId,
    ...staged,
    ...(generation ? { generation } : {}),
  });
  track(
    user,
    "scenario task started",
    {
      ...(generation ? generationProperties(generation.settings) : {}),
      start: baseCommit ? "repository" : "workspace",
    },
    tenant,
  );
  sendJson(response, 201, { task: taskItem(row) });
  return true;
}
