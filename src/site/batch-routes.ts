import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import type { AuthConfig } from "../auth/config.js";
import { GitHubOAuthError } from "../auth/github.js";
import type { User, UserStore } from "../auth/users.js";
import type { SelfBenchConfig } from "../config.js";
import { type BatchStatus, syncBatchProgress } from "./batch-progress.js";
import { type BatchStarter, batchSubmissionSchema, prepareBatch } from "./batch-start.js";
import type { RepoStore } from "./repo-store.js";
import type { RunStore } from "./run-store.js";
import type { TaskStore } from "./task-store.js";
import { tenantFor } from "./tenant.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/batches(?:\/(batch-[a-z0-9-]+)(?:\/(cancel))?)?$/;
export interface BatchRoutesOptions {
  config: SelfBenchConfig;
  auth: Pick<AuthConfig, "githubApiUrl">;
  users: UserStore;
  repos: RepoStore;
  runs: RunStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  start: BatchStarter;
  status: (runId: string) => Promise<BatchStatus>;
  cancel: (runId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}
export interface BatchRoutes {
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: User,
  ): Promise<boolean>;
}

export function createBatchRoutes(options: BatchRoutesOptions): BatchRoutes {
  const { users, repos, runs, tasks, artifacts } = options;
  return {
    async handle(request, url, response, user) {
      const match = route.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
      if (!repo) {
        sendJson(response, 404, { error: "repository is not connected here" });
        return true;
      }
      const runId = match[4];
      if (!runId && request.method === "POST") {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(request, 16 * 1024)).toString("utf8"));
        } catch {
          sendJson(response, 400, { error: "invalid batch request" });
          return true;
        }
        const parsed = batchSubmissionSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(response, 400, {
            error:
              "Request 1–10000 candidates total using nonnegative whole counts for easy, medium and hard.",
          });
          return true;
        }
        const token = await users.gitHubToken(user.githubId);
        if (!token) throw new GitHubOAuthError("no GitHub token stored for this user");
        const input = await prepareBatch({
          ...options,
          ...parsed.data,
          repo,
          token,
          githubApiUrl: options.auth.githubApiUrl,
        });
        // Persist ownership BEFORE starting paid work. A failed/ambiguous start remains visible
        // and recoverable under this repo rather than leaving an unowned running workflow.
        const run = await runs.attachRun(repo.id, input.runId, user.id);
        try {
          await options.start(input);
        } catch {
          sendJson(response, 503, {
            runId: input.runId,
            error: "Batch start could not be confirmed. Check this batch before starting another.",
          });
          return true;
        }
        sendJson(response, 202, { run, runId: input.runId });
        return true;
      }
      const attached = (await runs.runsFor(repo.id)).filter((run) =>
        run.runId.startsWith("batch-"),
      );
      if (!runId && request.method === "GET") {
        sendJson(response, 200, { batches: attached });
        return true;
      }
      if (!runId || !attached.some((run) => run.runId === runId)) {
        sendJson(response, 404, { error: "batch not found in this repository" });
        return true;
      }
      if (match[5] === "cancel" && request.method === "POST") {
        await options.cancel(runId);
        sendJson(response, 202, { runId, cancellationRequested: true });
        return true;
      }
      if (!match[5] && request.method === "GET") {
        const status = await options.status(runId);
        await syncBatchProgress({ repo, tasks, artifacts, status });
        sendJson(response, 200, status);
        return true;
      }
      return false;
    },
  };
}
