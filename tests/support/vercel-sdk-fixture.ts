import {
  authorizationHeader,
  collectBody,
  commandData,
  createdSandbox,
  json,
  readTarGzip,
  rejectWhenAborted,
  sandboxMetadata,
  streamingLogs,
} from "./vercel-sdk-http.js";

export const vercelFixtureImage = `iad1.vcr.dev/dari/selfbench/runtime@sha256:${"a".repeat(64)}`;

export const vercelFixtureConfig = {
  kind: "vercel" as const,
  credentials: {
    token: "vcp_test_token",
    teamId: "team_test",
    projectId: "prj_test",
  },
  image: vercelFixtureImage,
  timeoutCapMs: 2 * 60 * 60 * 1_000,
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
  commandStatusDelayMs = 0;
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
        if (this.commandStatusDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.commandStatusDelayMs));
        }
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
