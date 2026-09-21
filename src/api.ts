import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { Client } from "@temporalio/client";
import { z } from "zod";
import {
  authorized,
  bearerMatches,
  isReviewAssetPath,
  isSitePage,
  readBody,
  sendApiError,
  sendJson,
  sendReviewAsset,
} from "./api/http.js";
import { buildRunRequest } from "./api/run-request.js";
import { queryStatus } from "./api/status.js";
import { handleViewerRoute } from "./api/viewer-routes.js";
import { createArtifactStore } from "./artifacts.js";
import { apiKeyDenies } from "./auth/api-keys.js";
import type { AuthConfig } from "./auth/config.js";
import { sendIdentityError } from "./auth/routes.js";
import { sendExpiredSession } from "./auth/session-expired.js";
import { createGenerationBatches } from "./batches/service.js";
import type { SelfBenchConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { openSite } from "./site/runtime.js";
import { connectTemporalClient } from "./temporal/connection.js";
import { listArchivedRuns } from "./viewer/archived.js";
import type { ViewerInfo } from "./viewer/types.js";

export interface ApiOptions {
  /** When set, the API also serves the selfbench.dev site: GitHub sign-in and session cookies. */
  readonly auth?: AuthConfig;
}

export async function startApi(
  config: SelfBenchConfig,
  options: ApiOptions = {},
): Promise<() => Promise<void>> {
  const connection = await connectTemporalClient(config.temporal);
  const client = new Client({ connection, namespace: config.temporal.namespace });
  const artifacts = createArtifactStore(config.artifact);
  const site = options.auth ? await openSite(options.auth, config, client, artifacts) : undefined;
  const localDatabase =
    !site && process.env.SELFBENCH_DATABASE_URL
      ? await openDatabase(process.env.SELFBENCH_DATABASE_URL)
      : undefined;
  const batches =
    site?.generationBatches ??
    (localDatabase
      ? createGenerationBatches(localDatabase.db, client, artifacts, config.temporal.taskQueue)
      : undefined);
  const runStatus = (runId: string) =>
    batches ? batches.status(runId) : queryStatus(client.workflow.getHandle(runId));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (site) {
        if (await site.billing.webhook(request, url, response)) return;
        if (await site.auth.handle(request, url, response)) return;
        if (request.method === "GET" && url.pathname === "/v1/viewer") {
          sendJson(response, 200, { modes: ["runs"], auth: "github" } satisfies ViewerInfo);
          return;
        }
        if (request.method === "GET" && isSitePage(url.pathname)) {
          await sendReviewAsset(response, "/");
          return;
        }
      }
      if (request.method === "GET" && isReviewAssetPath(url.pathname)) {
        await sendReviewAsset(response, url.pathname);
        return;
      }
      // With sign-in enabled the CLI's bearer token still works, but nothing is open by default.
      const user = site ? await site.auth.authenticate(request, config.apiToken) : undefined;
      const allowed = site
        ? (config.apiToken !== undefined && bearerMatches(request, config.apiToken)) ||
          user !== undefined
        : authorized(request, config.apiToken);
      if (!allowed) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const denied = user ? apiKeyDenies(user, request.method) : undefined;
      if (denied) {
        sendJson(response, 403, { error: denied });
        return;
      }
      if (site && user && url.pathname.startsWith("/api/")) {
        if (await site.apiKeys.handle(request, url, response, user)) return;
        if (await site.billing.handle(request, url, response, user)) return;
        if (await site.github.handle(request, url, response, user)) return;
        if (await site.repos.handle(request, url, response, user)) return;
        if (await site.pullRequests.handle(request, url, response, user)) return;
        if (await site.evaluations.handle(request, url, response, user)) return;
        if (await site.batches.handle(request, url, response, user)) return;
        if (await site.tasks.handle(request, url, response, user)) return;
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
        if (!batches) throw new Error("Batch persistence requires SELFBENCH_DATABASE_URL");
        const token =
          user && site ? await site.users.gitHubToken(user.githubId) : process.env.GH_TOKEN;
        if (!token) throw new Error("A GitHub token is required for batch discovery");
        await batches.start(workflowInput, token);
        sendJson(response, 202, { runId: workflowInput.runId });
        return;
      }
      if (
        await handleViewerRoute(request, url, response, {
          store: artifacts,
          statusFor: runStatus,
        })
      ) {
        return;
      }
      const runMatch = /^\/v1\/runs\/([a-z0-9][a-z0-9-]{2,62})(?:\/(cancel|export))?$/.exec(
        url.pathname,
      );
      if (runMatch?.[1] && request.method === "GET" && runMatch[2] === "export") {
        const status = await runStatus(runMatch[1]);
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
        const status = await runStatus(runMatch[1]);
        sendJson(response, 200, status);
        return;
      }
      if (runMatch?.[1] && request.method === "POST" && runMatch[2] === "cancel") {
        if (batches) await batches.cancel(runMatch[1]);
        else await client.workflow.getHandle(runMatch[1]).cancel();
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
        for (const batch of (await batches?.list()) ?? [])
          runs.push({ runId: batch.run.runId, status: batch.phase });
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
      if (options.auth && sendIdentityError(response, error, options.auth.publicUrl)) return;
      if (options.auth && sendExpiredSession(response, error, options.auth.publicUrl)) return;
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
    if (site) await site.close();
    else await batches?.close();
    await localDatabase?.close();
    await connection.close();
    await site?.database.close();
  };
}

export { buildRunRequest } from "./api/run-request.js";
