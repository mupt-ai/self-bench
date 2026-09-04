import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { Client } from "@temporalio/client";
import { z } from "zod";
import {
  authorized,
  bearerMatches,
  readBody,
  sendApiError,
  sendJson,
  sendReviewAsset,
} from "./api/http.js";
import { buildRunRequest } from "./api/run-request.js";
import { queryStatus } from "./api/status.js";
import { handleViewerRoute } from "./api/viewer-routes.js";
import { type ArtifactStore, createArtifactStore } from "./artifacts.js";
import type { AuthConfig } from "./auth/config.js";
import { createSiteAuth, type SiteAuth } from "./auth/routes.js";
import { createPostgresUserStore } from "./auth/users.js";
import type { SelfBenchConfig } from "./config.js";
import { migrate } from "./db/migrations.js";
import { postgresClient, type SqlClient } from "./db/sql.js";
import { type ConnectedRepoRoutes, createConnectedRepoRoutes } from "./site/connected-repos.js";
import { createGitHubRepoRoutes, type GitHubRepoRoutes } from "./site/github-repos.js";
import { createPostgresRepoStore } from "./site/repo-store.js";
import { createPostgresRunStore } from "./site/run-store.js";
import { createPostgresTaskStore } from "./site/task-store.js";
import { createTaskRoutes, type TaskRoutes } from "./site/tasks.js";
import { connectTemporalClient } from "./temporal/connection.js";
import { selfBenchRunWorkflow } from "./temporal/workflow.js";
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
  const site = options.auth ? await openSite(options.auth, artifacts) : undefined;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (site) {
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
      if (
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname.startsWith("/assets/"))
      ) {
        await sendReviewAsset(response, url.pathname);
        return;
      }
      // With sign-in enabled the CLI's bearer token still works, but nothing is open by default.
      const user = site ? await site.auth.authenticate(request) : undefined;
      const allowed = site
        ? (config.apiToken !== undefined && bearerMatches(request, config.apiToken)) ||
          user !== undefined
        : authorized(request, config.apiToken);
      if (!allowed) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (site && user && url.pathname.startsWith("/api/")) {
        if (await site.github.handle(request, url, response, user)) return;
        if (await site.repos.handle(request, url, response, user)) return;
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
    await site?.sql.close();
  };
}

interface Site {
  readonly auth: SiteAuth;
  readonly github: GitHubRepoRoutes;
  readonly repos: ConnectedRepoRoutes;
  readonly tasks: TaskRoutes;
  readonly sql: SqlClient;
}

async function openSite(auth: AuthConfig, artifacts: ArtifactStore): Promise<Site> {
  const sql = postgresClient(auth.databaseUrl);
  const applied = await migrate(sql);
  if (applied.length > 0) console.log(`applied database migrations ${applied.join(", ")}`);
  const users = createPostgresUserStore(sql, { secret: auth.sessionSecret });
  const repos = createPostgresRepoStore(sql);
  const runs = createPostgresRunStore(sql);
  const tasks = createPostgresTaskStore(sql);
  return {
    auth: createSiteAuth({ config: auth, users }),
    github: createGitHubRepoRoutes({ config: auth, users }),
    repos: createConnectedRepoRoutes({ config: auth, users, repos }),
    tasks: createTaskRoutes({ users, repos, runs, tasks, artifacts }),
    sql,
  };
}

/**
 * Page paths load the SPA shell and let the router decide; API prefixes and anything that
 * looks like a file (assets, favicons) are left to the handlers below.
 */
function isSitePage(pathname: string): boolean {
  if (/^\/(v1|api|auth)(\/|$)/.test(pathname)) return false;
  const last = pathname.split("/").pop() ?? "";
  return !last.includes(".");
}

export { buildRunRequest } from "./api/run-request.js";
