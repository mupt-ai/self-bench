import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/**
 * Responses fixed in advance and tagged with a hash of their bytes, so a client or CDN holding
 * one is answered with a bodyless 304. They are compressed here rather than by the load
 * balancer: a response that already has a Content-Encoding passes through it untouched, while
 * one it compresses loses its tag, and with it every 304.
 */

/** A response body fixed in advance, with a tag that changes whenever the body does. */
export interface TaggedBody {
  readonly body: string;
  readonly etag: string;
}

/** Tags `body` with a hash of its bytes: the same body always gets the same tag. */
export function tagged(body: string): TaggedBody {
  return { body, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` };
}

type Encoding = "br" | "gzip";

/** Smaller bodies are sent as they are, as the load balancer does: compressing saves nothing. */
const MIN_COMPRESSED_BYTES = 1024;
/** How many compressed bodies are kept, so an unchanged body is compressed once, not per read. */
const KEEP = 64;
const compressed = new Map<string, Buffer>();

/** The encoding to send: brotli when accepted, else gzip, else none. A q of 0 refuses one. */
function encodingFor(header: string | undefined): Encoding | undefined {
  const accepted = new Set<string>();
  for (const entry of (header ?? "").split(",")) {
    const [name = "", ...params] = entry.trim().toLowerCase().split(";");
    const refused = params.some((param) => /^\s*q=0(\.0*)?\s*$/.test(param));
    if (name && !refused) accepted.add(name);
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip") || accepted.has("*")) return "gzip";
  return undefined;
}

/** `body` compressed with `encoding`, kept by its tag so the same body is compressed once. */
function compress({ body, etag }: TaggedBody, encoding: Encoding): Buffer {
  const key = `${etag}:${encoding}`;
  let bytes = compressed.get(key);
  if (!bytes) {
    bytes =
      encoding === "br"
        ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
        : gzipSync(body, { level: 9 });
    compressed.set(key, bytes);
    for (const oldest of compressed.keys()) {
      if (compressed.size <= KEEP) break;
      compressed.delete(oldest);
    }
  }
  return bytes;
}

/** Whether an `If-None-Match` header names `etag` (weak or strong), or is `*`. */
function names(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((entry) => entry.trim().replace(/^W\//, ""))
    .some((entry) => entry === "*" || entry === etag);
}

/**
 * Sends a tagged body with status 200, compressed when the client accepts it, or, when the
 * request already holds it (its `If-None-Match` names the tag), a 304 with no body. Each
 * encoding has its own tag, since its bytes differ. Its cache-control goes on both.
 */
export function sendTagged(
  request: IncomingMessage,
  response: ServerResponse,
  tag: TaggedBody,
  headers: { "cache-control": string; "content-type": string },
): void {
  const encoding =
    Buffer.byteLength(tag.body) >= MIN_COMPRESSED_BYTES
      ? encodingFor(request.headers["accept-encoding"])
      : undefined;
  const etag = encoding ? `${tag.etag.slice(0, -1)}-${encoding}"` : tag.etag;
  response.setHeader("etag", etag);
  response.setHeader("cache-control", headers["cache-control"]);
  response.setHeader("vary", "Accept-Encoding");
  if (names(request.headers["if-none-match"], etag)) {
    response.writeHead(304).end();
    return;
  }
  const bytes = encoding ? compress(tag, encoding) : tag.body;
  response.writeHead(200, {
    "content-type": headers["content-type"],
    "content-length": Buffer.byteLength(bytes),
    ...(encoding ? { "content-encoding": encoding } : {}),
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}
