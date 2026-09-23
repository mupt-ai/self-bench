import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { projectRoot } from "../lib/project-paths.js";
import { errorMessage } from "../lib/util.js";

export async function readBody(
  request: IncomingMessage,
  limit = 10 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > limit) throw new RequestBodyTooLargeError(limit);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function authorized(request: IncomingMessage, token: string | undefined): boolean {
  return !token || bearerMatches(request, token);
}

/** True only when a token is configured and the request presents exactly that token. */
export function bearerMatches(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

/** Paths of the built review app that are served without authentication. */
export function isReviewAssetPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/dari-logo.svg" || pathname.startsWith("/assets/");
}

export async function sendReviewAsset(response: ServerResponse, pathname: string): Promise<void> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const root = resolve(projectRoot(import.meta.url), "dist/review");
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    sendJson(response, 400, { error: "invalid asset path" });
    return;
  }
  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": contentType(path),
      "content-length": body.byteLength,
      // Only files under /assets/ carry a content hash in their name.
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "asset not found" });
  }
}

export function sendApiError(response: ServerResponse, error: unknown): void {
  const status = apiErrorStatus(error);
  if (status === 500) console.error(error);
  sendJson(response, status, {
    error: status === 500 ? "internal server error" : errorMessage(error),
  });
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

class RequestBodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

function apiErrorStatus(error: unknown): number {
  if (error instanceof RequestBodyTooLargeError) return 413;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400;
  return 500;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * Whether a state-changing request may proceed. Browser sessions are cookie-authenticated, so a
 * cross-site page could trigger them: they must come from the site's own origin, and any body must
 * be JSON (a plain form post cannot be). An API key cannot be attached by another site, so
 * key-authenticated requests are trusted as they are.
 */
export function trustedMutation(
  request: IncomingMessage,
  publicUrl: string,
  user: { readonly apiKey?: unknown },
): boolean {
  if (user.apiKey) return true;
  if (request.headers.origin !== new URL(publicUrl).origin) return false;
  const hasBody =
    Number(request.headers["content-length"] ?? 0) > 0 ||
    request.headers["transfer-encoding"] !== undefined;
  return !hasBody || (request.headers["content-type"]?.startsWith("application/json") ?? false);
}

/**
 * Repository paths belong to the SPA even when names or IDs contain dots.
 * API/auth routes and static assets keep their own handlers.
 */
export function isSitePage(pathname: string): boolean {
  if (/^\/(v1|api|auth|assets)(\/|$)/.test(pathname)) return false;
  if (/^\/repos\/[^/]+\/[^/]+(?:\/|$)/.test(pathname)) return true;
  const last = pathname.split("/").pop() ?? "";
  return !last.includes(".");
}
