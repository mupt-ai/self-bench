import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "../../artifacts/index.js";
import { artifactContentType, isRunArtifactKey } from "../../generation/runs/artifacts.js";
import { BundleNotFoundError, expandBundle } from "../../generation/runs/bundle.js";
import { sendJson } from "../http.js";

const RUN_ID = "([a-z0-9][a-z0-9-]{2,62})";
const artifactRoute = new RegExp(`^/v1/runs/${RUN_ID}/artifacts$`);
const bundleRoute = new RegExp(`^/v1/runs/${RUN_ID}/bundle$`);

/** Run artifacts and expanded task bundles, read by the web app's task pages. */
export async function handleRunArtifactRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  store: ArtifactStore,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  const bundle = bundleRoute.exec(url.pathname);
  if (bundle?.[1]) {
    const key = url.searchParams.get("key") ?? "";
    if (!isRunArtifactKey(bundle[1], key) || !key.endsWith(".tar.gz")) {
      sendJson(response, 400, { error: "invalid bundle key" });
      return true;
    }
    try {
      sendJson(response, 200, await expandBundle(store, key));
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
    const body = await store.openReadByKey(key, start > 0 ? { start } : {});
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
