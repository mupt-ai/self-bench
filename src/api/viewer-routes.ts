import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "../artifacts.js";
import type { RunStatus, TaskProgress } from "../contracts.js";
import { archivedCandidates } from "../viewer/archived.js";
import { artifactContentType, candidateArtifacts, isRunArtifactKey } from "../viewer/artifacts.js";
import { BundleNotFoundError, expandBundle } from "../viewer/bundle.js";
import { listCandidates } from "../viewer/candidates.js";
import type { CandidateList, ViewerInfo } from "../viewer/types.js";
import { sendJson } from "./http.js";

const RUN_ID = "([a-z0-9][a-z0-9-]{2,62})";
const TASK_ID = "([A-Za-z0-9][A-Za-z0-9._-]*)";
const candidatesRoute = new RegExp(`^/v1/runs/${RUN_ID}/candidates$`);
const candidateArtifactsRoute = new RegExp(`^/v1/runs/${RUN_ID}/candidates/${TASK_ID}/artifacts$`);
const artifactRoute = new RegExp(`^/v1/runs/${RUN_ID}/artifacts$`);
const bundleRoute = new RegExp(`^/v1/runs/${RUN_ID}/bundle$`);

export interface ViewerRouteContext {
  readonly store: ArtifactStore;
  readonly statusFor: (runId: string) => Promise<RunStatus | object>;
}

export async function handleViewerRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  context: ViewerRouteContext,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  if (url.pathname === "/v1/viewer") {
    sendJson(response, 200, { modes: ["runs"] } satisfies ViewerInfo);
    return true;
  }
  const candidates = candidatesRoute.exec(url.pathname);
  if (candidates?.[1]) {
    sendJson(response, 200, await resolveCandidates(context, candidates[1]));
    return true;
  }
  const artifacts = candidateArtifactsRoute.exec(url.pathname);
  if (artifacts?.[1] && artifacts[2]) {
    const list = await resolveCandidates(context, artifacts[1]);
    const task = findTask(list, artifacts[2]);
    if (!task) {
      sendJson(response, 404, { error: "candidate not found" });
      return true;
    }
    sendJson(response, 200, await candidateArtifacts(context.store, artifacts[1], task));
    return true;
  }
  const bundle = bundleRoute.exec(url.pathname);
  if (bundle?.[1]) {
    const key = url.searchParams.get("key") ?? "";
    if (!isRunArtifactKey(bundle[1], key) || !key.endsWith(".tar.gz")) {
      sendJson(response, 400, { error: "invalid bundle key" });
      return true;
    }
    try {
      sendJson(response, 200, await expandBundle(context.store, key));
    } catch (error) {
      if (error instanceof BundleNotFoundError) {
        sendJson(response, 404, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }
  const artifact = artifactRoute.exec(url.pathname);
  if (artifact?.[1]) {
    const key = url.searchParams.get("key") ?? "";
    if (!isRunArtifactKey(artifact[1], key)) {
      sendJson(response, 400, { error: "invalid artifact key" });
      return true;
    }
    const startText = url.searchParams.get("start");
    const start = startText === null ? 0 : Number(startText);
    if (!Number.isInteger(start) || start < 0) {
      sendJson(response, 400, { error: "invalid start offset" });
      return true;
    }
    const body = await context.store.openReadByKey(key, start > 0 ? { start } : {});
    if (!body) {
      sendJson(response, 404, { error: "artifact not found" });
      return true;
    }
    response.writeHead(start > 0 ? 206 : 200, {
      "content-type": artifactContentType(key),
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    });
    await pipeline(body, response);
    return true;
  }
  return false;
}

/**
 * Live runs come from the Temporal status query. Once Temporal's retention drops a
 * workflow, or while it has no task list yet, fall back to what the artifact store holds.
 */
async function resolveCandidates(
  context: ViewerRouteContext,
  runId: string,
): Promise<CandidateList> {
  const status = await context.statusFor(runId).catch(() => undefined);
  if (status && "tasks" in status && Array.isArray(status.tasks) && status.tasks.length > 0) {
    return listCandidates(context.store, status as RunStatus);
  }
  return archivedCandidates(context.store, runId);
}

function findTask(
  list: CandidateList,
  taskId: string,
): Pick<TaskProgress, "taskId" | "candidateId"> | undefined {
  return (
    list.candidates.find((task) => task.taskId === taskId) ??
    list.candidates.find((task) => task.candidateId === taskId)
  );
}
