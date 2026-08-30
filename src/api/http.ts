import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { projectRoot } from "../project-paths.js";

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
  if (!token) return true;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
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
      "cache-control": pathname === "/" ? "no-cache" : "public, max-age=31536000, immutable",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}
