import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts/index.js";
import { tenantFor } from "../auth/tenant.js";
import type { User, UserStore } from "../auth/users.js";
import type { GenerationCost } from "../contracts/index.js";
import type { RepoStore } from "../repos/store.js";
import { candidateArtifacts } from "../runs/artifacts.js";
import type { SandboxCostSnapshot } from "../sandbox/contracts.js";
import { TaskNotFoundError } from "./deletion.js";
import { refreshInProgress, refreshTask, type TaskStatusSource } from "./status.js";
import type { ReviewDecision, TaskRecord, TaskStore } from "./store.js";

const RUN_ID = "([a-z0-9][a-z0-9-]{2,62})";
const TASK_ID = "([A-Za-z0-9][A-Za-z0-9._-]*)";
const REPO = "([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)";
const ORG = "([A-Za-z0-9_.-]+)";
const countsRoute = new RegExp(`^/api/orgs/${ORG}/task-counts$`);
const tasksRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/tasks$`);
const taskRoute = new RegExp(
  `^/api/orgs/${ORG}/repos/${REPO}/tasks/${RUN_ID}/${TASK_ID}(?:/(review|artifacts|cancel))?$`,
);

/** How a task stands after the pipeline and, when present, a human. */
export type TaskState =
  | "needs_review"
  | "accepted"
  | "rejected"
  | "failed"
  | "cancelled"
  | "in_progress";

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
  readonly cost?: GenerationCost;
}

export interface TaskRoutesOptions {
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  /** When present, in-progress rows are brought up to date with their workflows on each list. */
  readonly status?: TaskStatusSource;
  readonly cost?: (
    runId: string,
    orgId: number,
    candidateId: string,
    live?: SandboxCostSnapshot,
  ) => Promise<GenerationCost | undefined>;
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
  const { users, repos, tasks, artifacts, status } = options;

  return {
    async handle(request, url, response, user) {
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
      const match = tasksRoute.exec(url.pathname) ?? taskRoute.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
      if (!repo || !tenant) {
        sendJson(response, 404, { error: "repository is not connected here" });
        return true;
      }
      if (tasksRoute.test(url.pathname) && request.method === "GET") {
        if (status) await refreshInProgress({ tasks, artifacts, status, repo });
        sendJson(response, 200, {
          tasks: (await tasks.listForRepo(repo.id)).map((task) => taskItem(task)),
        });
        return true;
      }
      const runId = match[4];
      const taskId = match[5];
      const leaf = match[6];
      if (!runId || !taskId) return false;
      if (leaf === "cancel" && request.method === "POST") {
        const found = await tasks.find(repo.id, runId, taskId);
        if (!found) {
          sendJson(response, 404, { error: "task not found" });
          return true;
        }
        if (found.pipelineStatus !== "in_progress") {
          sendJson(response, 200, {
            state: found.stage === "cancelled" ? "confirmed" : "finished",
          });
          return true;
        }
        if (!found.workflowId || !status?.cancel) {
          sendJson(response, 409, { error: "Cancellation is unavailable for this task." });
          return true;
        }
        await status.cancel(found.workflowId);
        sendJson(response, 202, { state: "requested" });
        return true;
      }
      if (!leaf && request.method === "DELETE") {
        const result = await tasks.deleteTask(repo.id, runId, taskId);
        if (result === "active") {
          sendJson(response, 409, { error: "Task generation is still in progress" });
        } else if (result === "missing") {
          sendJson(response, 404, { error: "task not found" });
        } else {
          sendJson(response, 200, { ok: true });
        }
        return true;
      }
      if (
        leaf &&
        request.method !== "GET" &&
        request.method !== "PUT" &&
        request.method !== "DELETE"
      )
        return false;
      if (!leaf && request.method !== "GET") return false;
      const found = await tasks.find(repo.id, runId, taskId);
      if (!found) {
        sendJson(response, 404, { error: "task not found" });
        return true;
      }
      if (!leaf) {
        let task = found;
        let liveCost: SandboxCostSnapshot | undefined;
        if (status) {
          if (found.pipelineStatus === "in_progress") {
            const refreshed = await refreshTask({ tasks, artifacts, status, repo }, found);
            task = refreshed.task;
            if (refreshed.snapshot?.kind === "running") liveCost = refreshed.snapshot.cost;
          } else {
            await refreshInProgress({ tasks, artifacts, status, repo });
            task = (await tasks.find(repo.id, runId, found.candidateId)) ?? found;
          }
        }
        const cost = options.cost
          ? await options.cost(runId, tenant.id, task.candidateId, liveCost)
          : undefined;
        sendJson(response, 200, { task: taskItem(task, cost) });
        return true;
      }
      const task = found;
      if (leaf === "review" && request.method === "PUT") {
        const body = await json(request);
        if (body.decision !== "approve" && body.decision !== "reject") {
          sendJson(response, 400, { error: "decision must be approve or reject" });
          return true;
        }
        const note = typeof body.note === "string" ? body.note.slice(0, 4000) : "";
        await sendReview(response, () =>
          tasks.review(task.id, {
            decision: body.decision as ReviewDecision,
            note,
            userId: user.id,
          }),
        );
        return true;
      }
      if (leaf === "review" && request.method === "DELETE") {
        await sendReview(response, () => tasks.clearReview(task.id));
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
  task: Pick<TaskRecord, "pipelineStatus"> & {
    stage?: string;
    review?: { decision: ReviewDecision };
  },
): TaskState {
  if (task.stage === "cancelled") return "cancelled";
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

export function taskItem(task: TaskRecord, cost?: GenerationCost): TaskListItem {
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
    ...(cost ? { cost } : {}),
  };
}

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(request, 64 * 1024)).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function sendReview(response: ServerResponse, update: () => Promise<TaskRecord>) {
  try {
    sendJson(response, 200, { task: taskItem(await update()) });
  } catch (error) {
    if (!(error instanceof TaskNotFoundError)) throw error;
    sendJson(response, 404, { error: error.message });
  }
}
