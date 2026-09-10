import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import type { AuthConfig } from "../auth/config.js";
import { GitHubOAuthError } from "../auth/github.js";
import type { User, UserStore } from "../auth/users.js";
import type { SelfBenchConfig } from "../config.js";
import { listCredentials } from "../evaluation/credentials.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { orgRecords } from "../evaluation/org-records.js";
import { EXECUTION_BACKENDS } from "../providers.js";
import { checkGenerationCredentials, generationRecordPath } from "./generation-credentials.js";
import { generationModels, generationSettingsSchema } from "./generation-settings.js";
import { candidateFromPullRequest, PullRequestError, parsePullRequestRef } from "./pr-candidate.js";
import { listMergedPullRequests, MAX_PR_PAGE } from "./pr-list.js";
import type { RepoStore } from "./repo-store.js";
import { startTaskFromPullRequest, taskRunId, type WorkflowStarter } from "./task-start.js";
import type { TaskStore } from "./task-store.js";
import { taskItem } from "./tasks.js";
import { tenantFor } from "./tenant.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(tasks\/from-pr|pull-requests|generation-options)$/;

export interface PullRequestRoutesOptions {
  readonly config: SelfBenchConfig;
  readonly auth: Pick<AuthConfig, "githubApiUrl">;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  readonly start: WorkflowStarter;
  readonly fetchImpl?: typeof fetch;
  readonly records?: EncryptedRecordStore;
}

export interface PullRequestRoutes {
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: User,
  ): Promise<boolean>;
}

/** POST …/tasks/from-pr {pr}: one merged PR becomes one task, built by its own workflow. */
export function createPullRequestRoutes(options: PullRequestRoutesOptions): PullRequestRoutes {
  const { config, auth, users, repos, tasks, artifacts, start } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async handle(request, url, response, user) {
      const match = route.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      const listing = match[4] === "pull-requests";
      const configuring = match[4] === "generation-options";
      if (request.method !== (listing || configuring ? "GET" : "POST")) return false;
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
      if (!repo || !tenant) {
        sendJson(response, 404, { error: "repository is not connected here" });
        return true;
      }
      if (listing) {
        const rawPage = url.searchParams.get("page") ?? "1";
        const page = Number(rawPage);
        if (!/^\d+$/.test(rawPage) || !Number.isInteger(page) || page < 1 || page > MAX_PR_PAGE) {
          sendJson(response, 400, { error: "invalid pull request page" });
          return true;
        }
        const token = await users.gitHubToken(user.githubId);
        if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
        const result = await listMergedPullRequests(auth, token, repo.fullName, page, fetchImpl);
        sendJson(response, 200, result);
        return true;
      }
      if (configuring) {
        sendJson(response, 200, {
          models: generationModels,
          sandboxes: EXECUTION_BACKENDS,
          credentials: options.records
            ? await listCredentials(orgRecords(options.records, tenant.id), tenant.id)
            : [],
          available: !!options.records,
        });
        return true;
      }
      const body = JSON.parse((await readBody(request, 16 * 1024)).toString("utf8") || "{}") as {
        pr?: unknown;
        generation?: unknown;
      };
      const parsed =
        body.generation === undefined
          ? undefined
          : generationSettingsSchema.safeParse(body.generation);
      if (parsed && !parsed.success) {
        sendJson(response, 400, {
          error: "Choose valid generation models, reasoning, sandbox, and credentials.",
        });
        return true;
      }
      const generation = parsed?.success
        ? { ownerId: tenant.id, orgId: tenant.id, repoId: repo.id, settings: parsed.data }
        : undefined;
      if (generation) {
        if (!options.records) {
          sendJson(response, 503, { error: "Generation credential storage is not configured." });
          return true;
        }
        try {
          await checkGenerationCredentials(
            orgRecords(options.records, tenant.id),
            tenant.id,
            generation.settings,
          );
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "Credential unavailable",
          });
          return true;
        }
      }
      const number = parsePullRequestRef(String(body.pr ?? ""), repo.fullName);
      if (!number) {
        sendJson(response, 400, {
          error: "pr must be a number or a pull request URL of this repository",
        });
        return true;
      }
      const token = await users.gitHubToken(user.githubId);
      if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
      let pullRequest: Awaited<ReturnType<typeof candidateFromPullRequest>>;
      try {
        pullRequest = await candidateFromPullRequest(auth, token, repo.fullName, number, fetchImpl);
      } catch (error) {
        if (!(error instanceof PullRequestError)) throw error;
        sendJson(response, error.status, { error: error.message });
        return true;
      }
      const runId = taskRunId(repo.fullName, number, 1);
      const row = await tasks.reserveStarted({
        repoId: repo.id,
        runId,
        candidateId: pullRequest.candidate.candidateId,
        taskId: pullRequest.candidate.candidateId,
        sourcePr: number,
        sourceUrl: pullRequest.candidate.sourceUrl,
        difficulty: pullRequest.candidate.difficulty,
        pipelineStatus: "in_progress",
        stage: "authoring",
        workflowId: `${runId}/candidate/${pullRequest.candidate.candidateId}`,
        startedBy: user.id,
      });
      await startTaskFromPullRequest({
        config,
        artifacts,
        start: async (workflowId, input) => {
          if (generation && options.records)
            await options.records.write(generationRecordPath(row.runId), generation, 0);
          await start(workflowId, input);
        },
        repository: repo,
        pullRequest,
        attempt: 1,
        runId: row.runId,
        ...(generation ? { generation } : {}),
      });
      sendJson(response, 201, { task: taskItem(row) });
      return true;
    },
  };
}
