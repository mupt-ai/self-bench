import { createServer } from "node:http";
import { Client } from "@temporalio/client";
import { createArtifactStore } from "../artifacts/index.js";
import type { SelfBenchConfig } from "../contracts/config/index.js";
import { apiKeyDenies } from "../db/api-keys.js";
import { openDatabase } from "../db/client.js";
import { createGenerationBatches, RunNotFoundError } from "../generation/batches/service.js";
import { connectTemporalClient } from "../temporal/connection.js";
import type { AuthConfig } from "./auth/config.js";
import { sendExpiredSession } from "./auth/session-expired.js";
import {
  authorized,
  bearerMatches,
  isReviewAssetPath,
  isSitePage,
  sendApiError,
  sendJson,
  sendReviewAsset,
} from "./http.js";
import { sendIdentityError } from "./routes/auth.js";
import { handleRunArtifactRoute } from "./routes/run-artifacts.js";
import { handleRunRoute } from "./routes/runs.js";
import { handleSandboxRoute } from "./routes/sandbox.js";
import { openSite } from "./site.js";

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
  const runStatus = async (runId: string) => {
    if (!batches) throw new RunNotFoundError(runId);
    return batches.status(runId);
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (site) {
        // The public results site's host is answered entirely by the public site.
        if (await site.resultsSite?.handle(request, url, response)) return;
        if (await site.billing.webhook(request, url, response)) return;
        if (await site.auth.handle(request, url, response)) return;
        if (await site.publicReleases.handle(request, url, response)) return;
        if (request.method === "GET" && isSitePage(url.pathname)) {
          await sendReviewAsset(response, "/");
          return;
        }
      }
      if (request.method === "GET" && isReviewAssetPath(url.pathname)) {
        await sendReviewAsset(response, url.pathname);
        return;
      }
      // Sandbox jobs authenticate with their own signed grant, not a user or the API token.
      if (
        config.sandboxCallback &&
        (await handleSandboxRoute(request, url, response, {
          secret: config.sandboxCallback.secret,
          store: artifacts,
          client,
        }))
      )
        return;
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
        if (await site.releases.handle(request, url, response, user)) return;
        if (await site.batches.handle(request, url, response, user)) return;
        if (await site.tasks.handle(request, url, response, user)) return;
      }
      if (await handleRunArtifactRoute(request, url, response, artifacts)) return;
      if (
        await handleRunRoute(request, url, response, {
          client,
          artifacts,
          batches,
          statusFor: runStatus,
        })
      )
        return;
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
