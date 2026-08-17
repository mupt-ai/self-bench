import { gunzipSync } from "node:zlib";

export const vercelFixtureImage = `iad1.vcr.dev/dari/selfbench/runtime@sha256:${"a".repeat(64)}`;

export const vercelFixtureConfig = {
  kind: "vercel" as const,
  credentials: {
    token: "vcp_test_token",
    teamId: "team_test",
    projectId: "prj_test",
  },
  image: vercelFixtureImage,
};

export interface RecordedVercelCall {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly authorization?: string;
}

export class VercelSdkFixture {
  readonly calls: RecordedVercelCall[] = [];
  readonly fetch: typeof globalThis.fetch;
  readonly outputs = new Map<string, Uint8Array>();
  readonly uploadedFiles = new Map<string, Uint8Array>();
  createFailsAfterAllocation = false;
  createHoldsAfterAllocation = false;
  readonly createStatuses: number[] = [];
  createRetryAfter = "30";
  commandStartStatus = 200;
  readonly commandStartStatuses: number[] = [];
  commandExitCode: number | null = 7;
  commandStatusFails = false;
  deleteFailuresRemaining = 0;
  deleteFailureMessage = "simulated lost delete response";
  getFails = false;
  getFailureMessage = "simulated cleanup recovery failure";
  getNotFoundResponsesRemaining = 0;
  logsMode: "complete" | "hold" | "one-then-hold" | "periodic" | "empty-pulse" = "complete";
  onCreateAllocated: (() => void) | undefined;
  sandboxExists = false;
  sandboxName = "";
  sessionCwd = "/work";
  sessionMemory = 8192;
  sessionStatus: "running" | "stopped" = "running";
  sessionVcpus = 4;
  writeFails = false;

  constructor() {
    const fixtureFetch = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      const authorization = authorizationHeader(init?.headers);
      this.calls.push({
        method,
        path: `${url.pathname}${url.search}`,
        ...(body === undefined ? {} : { body }),
        ...(authorization === undefined ? {} : { authorization }),
      });

      if (method === "POST" && url.pathname === "/api/v3/sandboxes") {
        const request = JSON.parse(body ?? "{}") as { name?: string };
        this.sandboxName = request.name ?? "";
        const status = this.createStatuses.shift() ?? 200;
        if (status !== 200) {
          return json(
            { error: "sandbox allocation rate limited" },
            status,
            status === 429 ? { "retry-after": this.createRetryAfter } : undefined,
          );
        }
        this.sandboxExists = true;
        this.onCreateAllocated?.();
        if (this.createFailsAfterAllocation) {
          throw new DOMException("simulated lost create response", "AbortError");
        }
        if (this.createHoldsAfterAllocation) {
          return await rejectWhenAborted(init?.signal);
        }
        return json(createdSandbox(this.sandboxName, this));
      }
      if (method === "POST" && url.pathname.endsWith("/fs/write")) {
        if (this.writeFails) {
          throw new DOMException("simulated upload failure", "AbortError");
        }
        for (const [path, contents] of readTarGzip(await collectBody(init?.body))) {
          this.uploadedFiles.set(path, contents);
        }
        return json({});
      }
      if (method === "POST" && url.pathname.endsWith("/cmd")) {
        const status = this.commandStartStatuses.shift() ?? this.commandStartStatus;
        if (status !== 200) {
          return json({ error: "temporary command failure" }, status);
        }
        const request = JSON.parse(body ?? "{}") as { command?: string; args?: string[] };
        return json({
          command: commandData({
            name: request.command ?? "",
            args: request.args ?? [],
            exitCode: null,
          }),
        });
      }
      if (method === "GET" && url.pathname.endsWith("/cmd/cmd_test/logs")) {
        if (this.logsMode !== "complete") {
          return streamingLogs(this.logsMode);
        }
        return new Response(
          [
            JSON.stringify({ stream: "stdout", data: "hello " }),
            JSON.stringify({ stream: "stderr", data: "warning\n" }),
            JSON.stringify({ stream: "stdout", data: "world\n" }),
            "",
          ].join("\n"),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      if (method === "GET" && url.pathname.endsWith("/cmd/cmd_test")) {
        if (this.commandStatusFails) {
          throw new DOMException("simulated command status failure", "AbortError");
        }
        return json({ command: commandData({ exitCode: this.commandExitCode }) });
      }
      if (method === "POST" && url.pathname.endsWith("/fs/read")) {
        const request = JSON.parse(body ?? "{}") as { path?: string };
        const output = request.path ? this.outputs.get(request.path) : undefined;
        return output
          ? new Response(Buffer.from(output), {
              headers: { "content-type": "application/octet-stream" },
            })
          : json({ error: "not found" }, 404);
      }
      if (
        method === "GET" &&
        url.pathname.startsWith("/api/v2/sandboxes/") &&
        !url.pathname.startsWith("/api/v2/sandboxes/sessions/")
      ) {
        if (this.getFails) {
          throw new DOMException(this.getFailureMessage, "AbortError");
        }
        if (!this.sandboxExists) {
          return json({ error: "not found" }, 404);
        }
        if (this.getNotFoundResponsesRemaining > 0) {
          this.getNotFoundResponsesRemaining -= 1;
          return json({ error: "not found" }, 404);
        }
        return json(createdSandbox(this.sandboxName, this));
      }
      if (method === "DELETE" && url.pathname.startsWith("/api/v2/sandboxes/")) {
        if (this.deleteFailuresRemaining > 0) {
          this.deleteFailuresRemaining -= 1;
          throw new DOMException(this.deleteFailureMessage, "AbortError");
        }
        this.sandboxExists = false;
        return json({ sandbox: sandboxMetadata(this.sandboxName, "stopped", this), routes: [] });
      }
      throw new Error(`unexpected Vercel SDK request: ${method} ${url.pathname}`);
    };
    this.fetch = Object.assign(fixtureFetch, { preconnect() {} });
  }
}

export function vercelRequestBody(
  calls: readonly RecordedVercelCall[],
  method: string,
  pathSuffix: string,
): Record<string, unknown> {
  const call = calls.find(
    (candidate) =>
      candidate.method === method && candidate.path.split("?")[0]?.endsWith(pathSuffix),
  );
  if (!call?.body) {
    throw new Error(`request not found: ${method} *${pathSuffix}`);
  }
  return JSON.parse(call.body) as Record<string, unknown>;
}

function createdSandbox(name: string, fixture: VercelSdkFixture): object {
  return {
    sandbox: sandboxMetadata(name, fixture.sessionStatus, fixture),
    session: sessionMetadata(fixture),
    routes: [],
    resumed: false,
  };
}

function sandboxMetadata(
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

function commandData(overrides: {
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

function json(body: object, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function streamingLogs(mode: Exclude<VercelSdkFixture["logsMode"], "complete">): Response {
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

async function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<never> {
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

async function collectBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  return Buffer.from(await new Response(body).arrayBuffer());
}

function readTarGzip(compressed: Uint8Array): Map<string, Uint8Array> {
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

function authorizationHeader(headers: HeadersInit | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }
  return new Headers(headers).get("authorization") ?? undefined;
}
