import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Client } from "@temporalio/client";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { RunStatus } from "../../contracts/index.js";
import type { createGenerationBatches } from "../../generation/batches/service.js";
import { listArchivedRuns } from "../../generation/runs/archived.js";
import { sendJson } from "../http.js";

const runRoute = /^\/v1\/runs\/([a-z0-9][a-z0-9-]{2,62})(?:\/(cancel|export))?$/;

export interface RunRouteContext {
  readonly client: Client;
  readonly artifacts: ArtifactStore;
  readonly batches: ReturnType<typeof createGenerationBatches> | undefined;
  readonly statusFor: (runId: string) => Promise<RunStatus | object>;
}

/** `/v1/runs` status, list, cancel, and export routes. */
export async function handleRunRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  context: RunRouteContext,
): Promise<boolean> {
  const { artifacts, batches, client } = context;
  if (request.method === "GET" && url.pathname === "/v1/runs") {
    sendJson(response, 200, await listRuns(context));
    return true;
  }
  const runMatch = runRoute.exec(url.pathname);
  const runId = runMatch?.[1];
  if (!runId) return false;
  if (request.method === "GET" && runMatch[2] === "export") {
    const status = await context.statusFor(runId);
    if (!("export" in status) || !status.export) {
      sendJson(response, 409, { error: "run export is not ready" });
      return true;
    }
    const body = await artifacts.openRead(status.export);
    response.writeHead(200, {
      "content-type": status.export.contentType,
      "content-length": status.export.sizeBytes,
      "content-disposition": `attachment; filename="selfbench-${runId}.tar.gz"`,
      "x-content-sha256": status.export.sha256,
    });
    await pipeline(body, response);
    return true;
  }
  if (request.method === "GET" && !runMatch[2]) {
    sendJson(response, 200, await context.statusFor(runId));
    return true;
  }
  if (request.method === "POST" && runMatch[2] === "cancel") {
    if (batches) await batches.cancel(runId);
    else await client.workflow.getHandle(runId).cancel();
    sendJson(response, 202, { runId, cancellationRequested: true });
    return true;
  }
  return false;
}

async function listRuns({ artifacts, batches }: RunRouteContext): Promise<unknown[]> {
  const runs: unknown[] = [];
  for (const batch of (await batches?.list()) ?? [])
    runs.push({ runId: batch.run.runId, status: batch.phase });
  const known = new Set(runs.map((run) => (run as { runId: string }).runId));
  for (const archived of await listArchivedRuns(artifacts)) {
    if (!known.has(archived.runId)) runs.push(archived);
  }
  return runs;
}
