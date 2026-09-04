import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { Client } from "@temporalio/client";
import { z } from "zod";
import { authorized, readBody, sendApiError, sendJson, sendReviewAsset } from "./api/http.js";
import { buildRunRequest } from "./api/run-request.js";
import { queryStatus } from "./api/status.js";
import { handleViewerRoute } from "./api/viewer-routes.js";
import { createArtifactStore } from "./artifacts.js";
import type { SelfBenchConfig } from "./config.js";
import { connectTemporalClient } from "./temporal/connection.js";
import { selfBenchRunWorkflow } from "./temporal/workflow.js";
import { listArchivedRuns } from "./viewer/archived.js";

export async function startApi(config: SelfBenchConfig): Promise<() => Promise<void>> {
  const connection = await connectTemporalClient(config.temporal);
  const client = new Client({ connection, namespace: config.temporal.namespace });
  const artifacts = createArtifactStore(config.artifact);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname.startsWith("/assets/"))
      ) {
        await sendReviewAsset(response, url.pathname);
        return;
      }
      if (!authorized(request, config.apiToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
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
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const workflowInput = buildRunRequest(
          config,
          JSON.parse((await readBody(request)).toString("utf8")),
        );
        await client.workflow.start(selfBenchRunWorkflow, {
          workflowId: workflowInput.runId,
          taskQueue: config.temporal.taskQueue,
          args: [workflowInput],
          workflowExecutionTimeout: "14 days",
        });
        sendJson(response, 202, { runId: workflowInput.runId });
        return;
      }
      if (
        await handleViewerRoute(request, url, response, {
          store: artifacts,
          statusFor: (runId) => queryStatus(client.workflow.getHandle(runId)),
        })
      ) {
        return;
      }
      const runMatch = /^\/v1\/runs\/([a-z0-9][a-z0-9-]{2,62})(?:\/(cancel|export))?$/.exec(
        url.pathname,
      );
      if (runMatch?.[1] && request.method === "GET" && runMatch[2] === "export") {
        const status = await queryStatus(client.workflow.getHandle(runMatch[1]));
        if (!("export" in status) || !status.export) {
          sendJson(response, 409, { error: "run export is not ready" });
          return;
        }
        const body = await artifacts.openRead(status.export);
        response.writeHead(200, {
          "content-type": status.export.contentType,
          "content-length": status.export.sizeBytes,
          "content-disposition": `attachment; filename="selfbench-${runMatch[1]}.tar.gz"`,
          "x-content-sha256": status.export.sha256,
        });
        await pipeline(body, response);
        return;
      }
      if (runMatch?.[1] && request.method === "GET" && !runMatch[2]) {
        const handle = client.workflow.getHandle(runMatch[1]);
        const status = await queryStatus(handle);
        sendJson(response, 200, status);
        return;
      }
      if (runMatch?.[1] && request.method === "POST" && runMatch[2] === "cancel") {
        await client.workflow.getHandle(runMatch[1]).cancel();
        sendJson(response, 202, { runId: runMatch[1], cancellationRequested: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
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
        const known = new Set(runs.map((run) => (run as { runId: string }).runId));
        for (const archived of await listArchivedRuns(artifacts)) {
          if (!known.has(archived.runId)) runs.push(archived);
        }
        sendJson(response, 200, runs);
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      sendApiError(response, error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.apiPort, config.apiHost, resolve);
  });
  return async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await connection.close();
  };
}

export { buildRunRequest } from "./api/run-request.js";
