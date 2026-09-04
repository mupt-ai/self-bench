import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import type { User, UserStore } from "../auth/users.js";
import { parallelMap } from "../parallel.js";
import { archivedCandidates, listArchivedRuns } from "../viewer/archived.js";
import { candidateArtifacts } from "../viewer/artifacts.js";
import type { CandidateSummary } from "../viewer/types.js";
import type { RepoStore } from "./repo-store.js";
import type { ReviewDecision, TaskReview, TaskStore } from "./task-store.js";
import { tenantFor } from "./tenant.js";

const RUN_ID = "([a-z0-9][a-z0-9-]{2,62})";
const TASK_ID = "([A-Za-z0-9][A-Za-z0-9._-]*)";
const REPO = "([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)";
const ORG = "([A-Za-z0-9_.-]+)";
const runsRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/runs$`);
const runRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/runs/${RUN_ID}$`);
const tasksRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/tasks$`);
const reviewRoute = new RegExp(
  `^/api/orgs/${ORG}/repos/${REPO}/tasks/${RUN_ID}/${TASK_ID}/review$`,
);
const artifactsRoute = new RegExp(
  `^/api/orgs/${ORG}/repos/${REPO}/tasks/${RUN_ID}/${TASK_ID}/artifacts$`,
);
const RUN_CONCURRENCY = 4;

/** How a task stands after the pipeline and, when present, a human. */
export type TaskState = "needs_review" | "accepted" | "rejected" | "in_progress";

export interface TaskListItem {
  readonly runId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly difficulty: string;
  readonly stage: string;
  readonly pipelineStatus: CandidateSummary["status"];
  readonly state: TaskState;
  readonly reasonSummary?: string;
  readonly sourcePr?: number;
  readonly sourceUrl?: string;
  readonly review?: Omit<TaskReview, "runId" | "taskId">;
}

export interface TaskRoutesOptions {
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
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
  const { users, repos, tasks, artifacts } = options;

  const resolveRepo = async (user: User, orgLogin: string, owner: string, name: string) => {
    const tenant = await tenantFor(users, user, orgLogin);
    if (!tenant) return undefined;
    return repos.find(tenant.id, `${owner}/${name}`);
  };

  const listTasks = async (repoId: number, fullName: string): Promise<TaskListItem[]> => {
    const [runs, reviews] = await Promise.all([tasks.runsFor(repoId), tasks.reviewsFor(repoId)]);
    const reviewFor = new Map(
      reviews.map((review) => [`${review.runId}:${review.taskId}`, review]),
    );
    const lists = await parallelMap(runs, RUN_CONCURRENCY, (run) =>
      archivedCandidates(artifacts, run.runId),
    );
    const items: TaskListItem[] = [];
    for (const list of lists) {
      for (const candidate of list.candidates) {
        const review = reviewFor.get(`${list.runId}:${candidate.taskId}`);
        items.push(taskItem(list.runId, candidate, review, fullName));
      }
    }
    return items.sort(
      (left, right) =>
        left.runId.localeCompare(right.runId) || left.taskId.localeCompare(right.taskId),
    );
  };

  return {
    async handle(request, url, response, user) {
      if (request.method === "GET" && url.pathname === "/api/runs") {
        sendJson(response, 200, { runs: await listArchivedRuns(artifacts) });
        return true;
      }
      const match =
        runsRoute.exec(url.pathname) ??
        runRoute.exec(url.pathname) ??
        tasksRoute.exec(url.pathname) ??
        reviewRoute.exec(url.pathname) ??
        artifactsRoute.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      const repo = await resolveRepo(user, match[1], match[2], match[3]);
      if (!repo) {
        sendJson(response, 404, { error: "repository is not connected here" });
        return true;
      }
      if (runsRoute.test(url.pathname) && request.method === "GET") {
        sendJson(response, 200, { runs: await tasks.runsFor(repo.id) });
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
        sendJson(response, 201, { run: await tasks.attachRun(repo.id, runId, user.id) });
        return true;
      }
      if (runRoute.test(url.pathname) && request.method === "DELETE" && match[4]) {
        const removed = await tasks.detachRun(repo.id, match[4]);
        sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "not attached" });
        return true;
      }
      if (tasksRoute.test(url.pathname) && request.method === "GET") {
        sendJson(response, 200, { tasks: await listTasks(repo.id, repo.fullName) });
        return true;
      }
      const runId = match[4];
      const taskId = match[5];
      if (!runId || !taskId) return false;
      if (reviewRoute.test(url.pathname) && request.method === "PUT") {
        const body = await json(request);
        if (body.decision !== "approve" && body.decision !== "reject") {
          sendJson(response, 400, { error: "decision must be approve or reject" });
          return true;
        }
        const note = typeof body.note === "string" ? body.note.slice(0, 4000) : "";
        const review = await tasks.review(repo.id, runId, taskId, {
          decision: body.decision as ReviewDecision,
          note,
          userId: user.id,
        });
        sendJson(response, 200, { review });
        return true;
      }
      if (reviewRoute.test(url.pathname) && request.method === "DELETE") {
        const removed = await tasks.clearReview(repo.id, runId, taskId);
        sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "no review" });
        return true;
      }
      if (artifactsRoute.test(url.pathname) && request.method === "GET") {
        const attached = (await tasks.runsFor(repo.id)).some((run) => run.runId === runId);
        if (!attached) {
          sendJson(response, 404, { error: "run is not attached to this repository" });
          return true;
        }
        const list = await archivedCandidates(artifacts, runId);
        const task =
          list.candidates.find((candidate) => candidate.taskId === taskId) ??
          list.candidates.find((candidate) => candidate.candidateId === taskId);
        if (!task) {
          sendJson(response, 404, { error: "task not found" });
          return true;
        }
        sendJson(response, 200, await candidateArtifacts(artifacts, runId, task));
        return true;
      }
      return false;
    },
  };
}

/** Pipeline verdict first, then the human's: a review overrides whatever the run concluded. */
export function taskState(
  candidate: Pick<CandidateSummary, "status" | "stage">,
  review: Pick<TaskReview, "decision"> | undefined,
): TaskState {
  if (review) return review.decision === "approve" ? "accepted" : "rejected";
  if (candidate.status === "accepted" || candidate.stage === "accepted") return "needs_review";
  if (candidate.status === "rejected" || candidate.status === "infrastructure_failed") {
    return "rejected";
  }
  if (candidate.status === "archived") return "rejected";
  return "in_progress";
}

/** Task ids carry the PR number ("…-pr-91809…"), which stands in when no definition was found. */
export function sourcePullRequest(
  candidate: Pick<CandidateSummary, "taskId" | "definition">,
  fullName: string,
): { sourcePr: number; sourceUrl: string } | undefined {
  if (candidate.definition) {
    return { sourcePr: candidate.definition.sourcePr, sourceUrl: candidate.definition.sourceUrl };
  }
  const number = /-pr-(\d+)(?:-|$)/.exec(candidate.taskId)?.[1];
  if (!number) return undefined;
  return {
    sourcePr: Number(number),
    sourceUrl: `https://github.com/${fullName}/pull/${number}`,
  };
}

function taskItem(
  runId: string,
  candidate: CandidateSummary,
  review: TaskReview | undefined,
  fullName: string,
): TaskListItem {
  return {
    runId,
    taskId: candidate.taskId,
    candidateId: candidate.candidateId,
    difficulty: candidate.difficulty,
    stage: candidate.stage,
    pipelineStatus: candidate.status,
    state: taskState(candidate, review),
    ...(candidate.reasonSummary ? { reasonSummary: candidate.reasonSummary } : {}),
    ...sourcePullRequest(candidate, fullName),
    ...(review
      ? {
          review: {
            decision: review.decision,
            note: review.note,
            decidedBy: review.decidedBy,
            decidedAt: review.decidedAt,
          },
        }
      : {}),
  };
}

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readBody(request, 64 * 1024)).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
