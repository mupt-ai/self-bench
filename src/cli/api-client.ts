import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export async function passthrough(method: "GET" | "POST", path: string): Promise<void> {
  console.log(JSON.stringify(await requestJson(path, { method }), null, 2));
}

export async function download(runId: string, outputPath: string): Promise<void> {
  const base = process.env.SELFBENCH_API_URL ?? "http://127.0.0.1:8080";
  const headers = new Headers();
  if (process.env.SELFBENCH_API_TOKEN) {
    headers.set("authorization", `Bearer ${process.env.SELFBENCH_API_TOKEN}`);
  }
  const response = await fetch(new URL(`/v1/runs/${encodeURIComponent(runId)}/export`, base), {
    headers,
  });
  if (!response.ok) {
    const value = (await response.json()) as Record<string, unknown>;
    throw new Error(String(value.error ?? `SelfBench API returned ${response.status}`));
  }
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
  options: { method: "GET" | "POST"; body?: Uint8Array; contentType?: string },
): Promise<Record<string, unknown>> {
  const base = process.env.SELFBENCH_API_URL ?? "http://127.0.0.1:8080";
  const headers = new Headers();
  if (options.contentType) {
    headers.set("content-type", options.contentType);
  }
  if (process.env.SELFBENCH_API_TOKEN) {
    headers.set("authorization", `Bearer ${process.env.SELFBENCH_API_TOKEN}`);
  }
  const response = await fetch(new URL(path, base), {
    method: options.method,
    headers,
    ...(options.body ? { body: Buffer.from(options.body) } : {}),
  });
  const value = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(value.error ?? `SelfBench API returned ${response.status}`));
  }
  return value;
}
