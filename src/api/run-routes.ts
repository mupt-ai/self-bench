import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Client } from "@temporalio/client";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/index.js";
import type { createGenerationBatches } from "../batches/service.js";
import type { SelfBenchConfig } from "../config/index.js";
import type { RunStatus } from "../contracts/index.js";
import { listArchivedRuns } from "../runs/archived.js";
import { readBody, sendJson } from "./http.js";
import { buildRunRequest } from "./run-request.js";

const runRoute = /^\/v1\/runs\/([a-z0-9][a-z0-9-]{2,62})(?:\/(cancel|export))?$/;

export interface RunRouteContext {
  readonly config: SelfBenchConfig;
  readonly client: Client;
  readonly artifacts: ArtifactStore;
  readonly batches: ReturnType<typeof createGenerationBatches> | undefined;
  readonly statusFor: (runId: string) => Promise<RunStatus | object>;
  /** The GitHub token batch discovery runs with: the signed-in user's, or the operator's. */
  readonly githubToken: () => Promise<string | undefined>;
}

/** CLI-facing `/v1/runs` and `/v1/provenance` routes. */
export async function handleRunRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  context: RunRouteContext,
): Promise<boolean> {
  const { artifacts, batches, client } = context;
  if (request.method === "POST" && url.pathname === "/v1/provenance") {
    const runId = z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
      .parse(url.searchParams.get("runId"));
    const body = await readBody(request, 100 * 1024 * 1024);
    const reference = await artifacts.put(
      `runs/${runId}/input/provenance.jsonl`,
      body,
      "application/x-ndjson",
    );
    sendJson(response, 201, reference);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/v1/runs") {
    const workflowInput = buildRunRequest(
      context.config,
      JSON.parse((await readBody(request)).toString("utf8")),
    );
    if (!batches) throw new Error("Batch persistence requires SELFBENCH_DATABASE_URL");
    const token = await context.githubToken();
    if (!token) throw new Error("A GitHub token is required for batch discovery");
    await batches.start(workflowInput, token);
    sendJson(response, 202, { runId: workflowInput.runId });
    return true;
  }
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

async function listRuns({ artifacts, batches, client }: RunRouteContext): Promise<unknown[]> {
  const runs: unknown[] = [];
  for await (const execution of client.workflow.list({
    query: "WorkflowType = 'selfBenchRunWorkflow'",
  })) {
    runs.push({
      runId: execution.workflowId,
      status: execution.status.name,
      startedAt: execution.startTime.toISOString(),
      closedAt: execution.closeTime?.toISOString(),
    });
    if (runs.length >= 1_000) break;
  }
  for (const batch of (await batches?.list()) ?? [])
    runs.push({ runId: batch.run.runId, status: batch.phase });
  const known = new Set(runs.map((run) => (run as { runId: string }).runId));
  for (const archived of await listArchivedRuns(artifacts)) {
    if (!known.has(archived.runId)) runs.push(archived);
  }
  return runs;
}
