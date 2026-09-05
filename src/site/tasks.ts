import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import type { User, UserStore } from "../auth/users.js";
import { listArchivedRuns } from "../viewer/archived.js";
import { candidateArtifacts } from "../viewer/artifacts.js";
import type { ConnectedRepo, RepoStore } from "./repo-store.js";
import type { RunStore } from "./run-store.js";
import { refreshInProgress, type TaskStatusSource } from "./task-status.js";
import type { ReviewDecision, TaskRecord, TaskStore } from "./task-store.js";
import { syncRun } from "./task-sync.js";
import { tenantFor } from "./tenant.js";

const RUN_ID = "([a-z0-9][a-z0-9-]{2,62})";
const TASK_ID = "([A-Za-z0-9][A-Za-z0-9._-]*)";
const REPO = "([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)";
const ORG = "([A-Za-z0-9_.-]+)";
const countsRoute = new RegExp(`^/api/orgs/${ORG}/task-counts$`);
const runsRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/runs$`);
const runRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/runs/${RUN_ID}$`);
const syncRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/sync$`);
const tasksRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/tasks$`);
const taskRoute = new RegExp(
  `^/api/orgs/${ORG}/repos/${REPO}/tasks/${RUN_ID}/${TASK_ID}/(review|artifacts)$`,
);

/** How a task stands after the pipeline and, when present, a human. */
export type TaskState = "needs_review" | "accepted" | "rejected" | "failed" | "in_progress";

export interface TaskListItem {
  readonly runId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly difficulty: string;
  readonly stage: string;
  readonly pipelineStatus: TaskRecord["pipelineStatus"];
  readonly state: TaskState;
  readonly reasonSummary?: string;
  readonly reason?: string;
  readonly sourcePr?: number;
  readonly sourceUrl?: string;
  readonly review?: TaskRecord["review"];
  readonly syncedAt: string;
  readonly round?: number;
  readonly workflowId?: string;
  readonly startedBy?: string;
  readonly startedAt?: string;
}

export interface TaskRoutesOptions {
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly runs: RunStore;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  /** When present, in-progress rows are brought up to date with their workflows on each list. */
  readonly status?: TaskStatusSource;
}

export interface TaskRoutes {
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: User,
  ): Promise<boolean>;
}

export function createTaskRoutes(options: TaskRoutesOptions): TaskRoutes {
  const { users, repos, runs, tasks, artifacts, status } = options;

  const syncAll = async (repo: ConnectedRepo): Promise<number> => {
    let synced = 0;
    for (const run of await runs.runsFor(repo.id)) {
      synced += (await syncRun({ tasks, artifacts, repo, runId: run.runId })).synced;
    }
    return synced;
  };

  return {
    async handle(request, url, response, user) {
      if (request.method === "GET" && url.pathname === "/api/runs") {
        sendJson(response, 200, { runs: await listArchivedRuns(artifacts) });
        return true;
      }
      const counts = countsRoute.exec(url.pathname);
      if (counts?.[1] && request.method === "GET") {
        const tenant = await tenantFor(users, user, counts[1]);
        if (!tenant) {
          sendJson(response, 404, { error: "unknown organization" });
          return true;
        }
        const connected = await repos.list(tenant.id);
        const byRepo = new Map(connected.map((repo) => [repo.id, repo.fullName]));
        const found = await tasks.countsForRepos(connected.map((repo) => repo.id));
        sendJson(response, 200, {
          counts: Object.fromEntries(
            found.map(({ repoId, ...rest }) => [byRepo.get(repoId) ?? String(repoId), rest]),
          ),
        });
        return true;
      }
      const match =
        runsRoute.exec(url.pathname) ??
        runRoute.exec(url.pathname) ??
        syncRoute.exec(url.pathname) ??
        tasksRoute.exec(url.pathname) ??
        taskRoute.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
      if (!repo) {
        sendJson(response, 404, { error: "repository is not connected here" });
        return true;
      }
      if (runsRoute.test(url.pathname) && request.method === "GET") {
        sendJson(response, 200, { runs: await runs.runsFor(repo.id) });
        return true;
      }
      if (runsRoute.test(url.pathname) && request.method === "POST") {
        const body = await json(request);
        const runId = typeof body.runId === "string" ? body.runId : "";
        const known = (await listArchivedRuns(artifacts)).some((run) => run.runId === runId);
        if (!known) {
          sendJson(response, 404, { error: "run not found in the artifact store" });
          return true;
        }
        const run = await runs.attachRun(repo.id, runId, user.id);
        const { synced } = await syncRun({ tasks, artifacts, repo, runId });
        sendJson(response, 201, { run, synced });
        return true;
      }
      if (runRoute.test(url.pathname) && request.method === "DELETE" && match[4]) {
        const removed = await runs.detachRun(repo.id, match[4]);
        if (removed) await tasks.deleteForRun(repo.id, match[4]);
        sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "not attached" });
        return true;
      }
      if (syncRoute.test(url.pathname) && request.method === "POST") {
        sendJson(response, 200, { synced: await syncAll(repo) });
        return true;
      }
      if (tasksRoute.test(url.pathname) && request.method === "GET") {
        if (status) await refreshInProgress({ tasks, artifacts, status, repo });
        sendJson(response, 200, { tasks: (await tasks.listForRepo(repo.id)).map(taskItem) });
        return true;
      }
      const runId = match[4];
      const taskId = match[5];
      const leaf = match[6];
      if (!runId || !taskId || !leaf) return false;
      const task = await tasks.find(repo.id, runId, taskId);
      if (!task) {
        sendJson(response, 404, { error: "task not found" });
        return true;
      }
      if (leaf === "review" && request.method === "PUT") {
        const body = await json(request);
        if (body.decision !== "approve" && body.decision !== "reject") {
          sendJson(response, 400, { error: "decision must be approve or reject" });
          return true;
        }
        const note = typeof body.note === "string" ? body.note.slice(0, 4000) : "";
        const updated = await tasks.review(task.id, {
          decision: body.decision as ReviewDecision,
          note,
          userId: user.id,
        });
        sendJson(response, 200, { task: taskItem(updated) });
        return true;
      }
      if (leaf === "review" && request.method === "DELETE") {
        sendJson(response, 200, { task: taskItem(await tasks.clearReview(task.id)) });
        return true;
      }
      if (leaf === "artifacts" && request.method === "GET") {
        sendJson(response, 200, await candidateArtifacts(artifacts, runId, task));
        return true;
      }
      return false;
    },
  };
}

/** Pipeline verdict first, then the human's: a review overrides whatever the run concluded. */
export function taskState(
  task: Pick<TaskRecord, "pipelineStatus"> & { review?: { decision: ReviewDecision } },
): TaskState {
  if (task.review) return task.review.decision === "approve" ? "accepted" : "rejected";
  switch (task.pipelineStatus) {
    case "accepted":
      return "needs_review";
    case "rejected":
      return "rejected";
    case "infrastructure_failed":
      return "failed";
    default:
      return "in_progress";
  }
}

export function taskItem(task: TaskRecord): TaskListItem {
  const reason = task.reason;
  return {
    runId: task.runId,
    taskId: task.taskId,
    candidateId: task.candidateId,
    difficulty: task.difficulty,
    stage: task.stage,
    pipelineStatus: task.pipelineStatus,
    state: taskState(task),
    ...(reason ? { reason, reasonSummary: reason.split("\n")[0]?.slice(0, 240) ?? reason } : {}),
    ...(task.sourcePr !== undefined ? { sourcePr: task.sourcePr } : {}),
    ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
    ...(task.review ? { review: task.review } : {}),
    syncedAt: task.syncedAt,
    ...(task.round !== undefined ? { round: task.round } : {}),
    ...(task.workflowId ? { workflowId: task.workflowId } : {}),
    ...(task.startedBy ? { startedBy: task.startedBy } : {}),
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
  };
}

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(request, 64 * 1024)).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
