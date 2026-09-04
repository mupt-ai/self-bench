import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import type { AuthConfig } from "../auth/config.js";
import { GitHubOAuthError } from "../auth/github.js";
import type { User, UserStore } from "../auth/users.js";
import type { SelfBenchConfig } from "../config.js";
import { candidateFromPullRequest, PullRequestError, parsePullRequestRef } from "./pr-candidate.js";
import type { RepoStore } from "./repo-store.js";
import { startTaskFromPullRequest, type WorkflowStarter } from "./task-start.js";
import type { TaskStore } from "./task-store.js";
import { taskItem } from "./tasks.js";
import { tenantFor } from "./tenant.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tasks\/from-pr$/;

export interface PullRequestRoutesOptions {
  readonly config: SelfBenchConfig;
  readonly auth: Pick<AuthConfig, "githubApiUrl">;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  readonly start: WorkflowStarter;
  readonly fetchImpl?: typeof fetch;
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
      if (!match?.[1] || !match[2] || !match[3] || request.method !== "POST") return false;
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
      if (!repo) {
        sendJson(response, 404, { error: "repository is not connected here" });
        return true;
      }
      const body = JSON.parse((await readBody(request, 16 * 1024)).toString("utf8") || "{}") as {
        pr?: unknown;
      };
      const number = parsePullRequestRef(String(body.pr ?? ""), repo.fullName);
      if (!number) {
        sendJson(response, 400, {
          error: "pr must be a number or a pull request URL of this repository",
        });
        return true;
      }
      const token = await users.gitHubToken(user.githubId);
      if (!token) throw new GitHubOAuthError("no GitHub token stored for this user");
      let pullRequest: Awaited<ReturnType<typeof candidateFromPullRequest>>;
      try {
        pullRequest = await candidateFromPullRequest(auth, token, repo.fullName, number, fetchImpl);
      } catch (error) {
        if (!(error instanceof PullRequestError)) throw error;
        sendJson(response, error.status, { error: error.message });
        return true;
      }
      const attempt =
        1 +
        (await tasks.listForRepo(repo.id)).filter(
          (task) => task.sourcePr === number && task.workflowId,
        ).length;
      const started = await startTaskFromPullRequest({
        config,
        artifacts,
        start,
        repository: repo,
        pullRequest,
        attempt,
      });
      const row = await tasks.insertStarted({
        repoId: repo.id,
        runId: started.runId,
        candidateId: started.candidate.candidateId,
        taskId: started.candidate.candidateId,
        sourcePr: number,
        sourceUrl: started.candidate.sourceUrl,
        difficulty: started.candidate.difficulty,
        pipelineStatus: "in_progress",
        stage: "authoring",
        workflowId: started.workflowId,
        startedBy: user.id,
      });
      sendJson(response, 201, { task: taskItem(row) });
      return true;
    },
  };
}
