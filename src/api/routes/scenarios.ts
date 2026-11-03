import type { IncomingMessage, ServerResponse } from "node:http";
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
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { requestedGeneration } from "./generation-request.js";
import type { PullRequestRoutesOptions } from "./pull-requests.js";
import { taskItem } from "./tasks.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/from-scenario$/;

/**
 * POST …/tasks/from-scenario {title, scenario, difficulty?, attachments?, generation}: a person's
 * description of a situation an agent should handle becomes one task, built by its own workflow
 * as a PR from Add PRs is. Its author writes the workspace the agent starts in; nothing is read
 * from GitHub, so an API key works as well as a browser session.
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
  const candidateId = scenarioCandidateId(body.title);
  const row = await tasks.reserveStarted({
    repoId: repo.id,
    runId: scenarioRunId(repo.fullName),
    candidateId,
    taskId: candidateId,
    title: body.title,
    difficulty: body.difficulty,
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
  });
  if (generation && options.vault)
    await saveGenerationRecords(options.vault.records, row.runId, generation, undefined);
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
    generation ? generationProperties(generation.settings) : {},
    tenant,
  );
  sendJson(response, 201, { task: taskItem(row) });
  return true;
}
