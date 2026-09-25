import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "../../artifacts/index.js";
import { readSnapshotLink, SNAPSHOT_LINK_PATH } from "../../sandbox/snapshot-link.js";
import { sendJson } from "../http.js";

const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

/**
 * Repository snapshots for remote Harbor image builds. The signed link is the credential; the
 * build is redirected to a short-lived storage URL, or streamed here when the store has none.
 */
export async function handleSnapshotRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  options: { readonly secret: string; readonly store: ArtifactStore },
): Promise<boolean> {
  if (!url.pathname.startsWith(SNAPSHOT_LINK_PATH)) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method not allowed" });
    return true;
  }
  const link = readSnapshotLink(url.pathname, options.secret);
  const object = link && (await options.store.stat(link.key));
  if (!link || !object || object.sha256 !== link.sha256) {
    sendJson(response, 404, { error: "not found" });
    return true;
  }
  const reference = { ...object, contentType: "application/gzip" };
  const signed = await options.store.signedReadUrl?.(reference, SIGNED_URL_TTL_MS);
  if (signed) {
    response.writeHead(302, { location: signed, "cache-control": "no-store" }).end();
    return true;
  }
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": String(object.sizeBytes),
  });
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  await pipeline(await options.store.openRead(reference), response);
  return true;
}
