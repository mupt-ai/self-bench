import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { readConfig } from "./config.js";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The hosted app; SELFBENCH_API_URL points elsewhere, such as a self-hosted or local deployment. */
const DEFAULT_API_URL = "https://app.selfbench.dev";

export async function passthrough(method: Method, path: string, json?: unknown): Promise<void> {
  console.log(JSON.stringify(await requestJson(path, method, json), null, 2));
}

export async function download(runId: string, outputPath: string): Promise<void> {
  const path = `/v1/runs/${encodeURIComponent(runId)}/export`;
  const response = await fetch(apiUrl(path), { headers: authHeaders(path) });
  if (!response.ok) throw await apiError(response);
  const expectedSha256 = response.headers.get("x-content-sha256");
  if (!expectedSha256 || !response.body) {
    throw new Error("SelfBench API returned an export without integrity metadata");
  }
  const destination = resolve(outputPath);
  const file = await open(destination, "wx");
  let verified = false;
  try {
    const hash = createHash("sha256");
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(undefined, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      hasher,
      file.createWriteStream(),
    );
    if (hash.digest("hex") !== expectedSha256) {
      throw new Error("downloaded export failed its SHA-256 integrity check");
    }
    verified = true;
  } finally {
    await file.close().catch(() => undefined);
    if (!verified) {
      await rm(destination, { force: true });
    }
  }
  console.log(JSON.stringify({ runId, output: destination }, null, 2));
}

export async function requestJson(
  path: string,
  method: Method = "GET",
  json?: unknown,
): Promise<Record<string, unknown>> {
  const headers = authHeaders(path);
  if (json !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(path), {
    method,
    headers,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as Record<string, unknown>;
}

/** A binary response, checked against the SHA-256 the server sent with it. */
export async function requestBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(apiUrl(path), { headers: authHeaders(path) });
  if (!response.ok) throw await apiError(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = response.headers.get("x-content-sha256");
  if (expected && createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("the download failed its SHA-256 integrity check");
  return bytes;
}

/** SELFBENCH_API_URL, else the deployment `login` signed in to, else the hosted app. */
export function apiOrigin(): string {
  return process.env.SELFBENCH_API_URL || readConfig().apiUrl || DEFAULT_API_URL;
}

function apiUrl(path: string): URL {
  return new URL(path, apiOrigin());
}

/**
 * A personal API key (SELFBENCH_API_KEY, else the one `login` saved) acts as its owner, which the /api routes need;
 * the operator's SELFBENCH_API_TOKEN is preferred on /v1, where registry grants need it. Either
 * goes as the bearer token.
 */
function authHeaders(path: string): Headers {
  const headers = new Headers();
  const { SELFBENCH_API_TOKEN: operator } = process.env;
  const key = process.env.SELFBENCH_API_KEY || readConfig().apiKey;
  const token = path.startsWith("/api/") ? key || operator : operator || key;
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function apiError(response: Response): Promise<Error> {
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return new Error(String(value.error ?? `SelfBench API returned ${response.status}`));
}
