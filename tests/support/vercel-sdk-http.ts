import { gunzipSync } from "node:zlib";
import type { VercelSdkFixture } from "./vercel-sdk-fixture.js";

const vercelFixtureImage = `iad1.vcr.dev/dari/selfbench/runtime@sha256:${"a".repeat(64)}`;

export function createdSandbox(name: string, fixture: VercelSdkFixture): object {
  return {
    sandbox: sandboxMetadata(name, fixture.sessionStatus, fixture),
    session: sessionMetadata(fixture),
    routes: [],
    resumed: false,
  };
}

export function sandboxMetadata(
  name: string,
  status: "running" | "stopped",
  fixture: VercelSdkFixture,
): object {
  const now = Date.now();
  return {
    name,
    persistent: false,
    region: "iad1",
    vcpus: fixture.sessionVcpus,
    memory: fixture.sessionMemory,
    timeout: 60_000,
    image: vercelFixtureImage,
    createdAt: now,
    updatedAt: now,
    currentSessionId: "ses_test",
    status,
    cwd: fixture.sessionCwd,
  };
}

function sessionMetadata(fixture: VercelSdkFixture): object {
  const now = Date.now();
  return {
    id: "ses_test",
    memory: fixture.sessionMemory,
    vcpus: fixture.sessionVcpus,
    region: "iad1",
    timeout: 60_000,
    status: fixture.sessionStatus,
    requestedAt: now,
    startedAt: now,
    createdAt: now,
    cwd: fixture.sessionCwd,
    updatedAt: now,
  };
}

export function commandData(overrides: {
  readonly name?: string;
  readonly args?: string[];
  readonly exitCode: number | null;
}): object {
  return {
    id: "cmd_test",
    name: overrides.name ?? "/bin/bash",
    args: overrides.args ?? [],
    cwd: "/work",
    sessionId: "ses_test",
    exitCode: overrides.exitCode,
    durationMs: overrides.exitCode === null ? undefined : 25,
    startedAt: Date.now(),
  };
}

export function json(body: object, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function streamingLogs(mode: Exclude<VercelSdkFixture["logsMode"], "complete">): Response {
  let interval: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (data: string): void => {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify({ stream: "stdout", data })}\n`),
        );
      };
      if (mode === "one-then-hold") {
        enqueue("first\n");
        return;
      }
      if (mode === "periodic") {
        let count = 0;
        const emit = (): void => {
          count += 1;
          enqueue(`tick-${count}\n`);
          if (count === 4) {
            clearInterval(interval);
            controller.close();
          }
        };
        emit();
        interval = setInterval(emit, 10);
        return;
      }
      if (mode === "empty-pulse") {
        enqueue("");
        interval = setInterval(() => enqueue(""), 5);
      }
    },
    cancel() {
      clearInterval(interval);
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

export async function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<never> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
  return await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
      { once: true },
    );
  });
}

export async function collectBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  return Buffer.from(await new Response(body).arrayBuffer());
}

export function readTarGzip(compressed: Uint8Array): Map<string, Uint8Array> {
  const archive = gunzipSync(compressed);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = cString(header.subarray(0, 100));
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim() || "0", 8);
    const start = offset + 512;
    files.set(name, archive.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString("utf8");
}

export function authorizationHeader(headers: HeadersInit | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }
  return new Headers(headers).get("authorization") ?? undefined;
}
