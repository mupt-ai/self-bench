import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Client } from "@temporalio/client";
import { z } from "zod";
import { createArtifactStore } from "./artifacts.js";
import type { SelfBenchConfig } from "./config.js";
import {
  artifactRefSchema,
  type RunPhase,
  type RunRequest,
  type RunStatus,
  repositoryRefSchema,
  runRequestSchema,
} from "./contracts.js";
import { projectRoot } from "./project-paths.js";
import { connectTemporalClient } from "./temporal/connection.js";
import { selfBenchRunWorkflow, statusQuery } from "./temporal/workflow.js";

const submissionSchema = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  repository: repositoryRefSchema,
  provenance: artifactRefSchema,
  candidateCounts: z.object({
    easy: z.number().int().min(0).max(100),
    medium: z.number().int().min(0).max(100),
    hard: z.number().int().min(0).max(100),
  }),
  authoringModel: z.string().min(1).default("gpt-5.6-sol"),
  selfbenchCommit: z.string().regex(/^[0-9a-f]{40}$/i),
});

export async function startApi(config: SelfBenchConfig): Promise<() => Promise<void>> {
  const connection = await connectTemporalClient(config.temporal);
  const client = new Client({ connection, namespace: config.temporal.namespace });
  const artifacts = createArtifactStore(config.artifact);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/" || url.pathname.startsWith("/assets/"))
      ) {
        await sendReviewAsset(response, url.pathname);
        return;
      }
      if (!authorized(request, config.apiToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/provenance") {
        const runId = z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
          .parse(url.searchParams.get("runId"));
        const body = await readBody(request, 100 * 1024 * 1024);
        const reference = await artifacts.put(
          `runs/${runId}/input/provenance.jsonl`,
          body,
          "application/x-ndjson",
        );
        sendJson(response, 201, reference);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const workflowInput = buildRunRequest(
          config,
          JSON.parse((await readBody(request)).toString("utf8")),
        );
        await client.workflow.start(selfBenchRunWorkflow, {
          workflowId: workflowInput.runId,
          taskQueue: config.temporal.taskQueue,
          args: [workflowInput],
          workflowExecutionTimeout: "14 days",
        });
        sendJson(response, 202, { runId: workflowInput.runId });
        return;
      }
      const runMatch = /^\/v1\/runs\/([a-z0-9][a-z0-9-]{2,62})(?:\/(cancel|export))?$/.exec(
        url.pathname,
      );
      if (runMatch?.[1] && request.method === "GET" && runMatch[2] === "export") {
        const status = await queryStatus(client.workflow.getHandle(runMatch[1]));
        if (!("export" in status) || !status.export) {
          sendJson(response, 409, { error: "run export is not ready" });
          return;
        }
        const body = await artifacts.openRead(status.export);
        response.writeHead(200, {
          "content-type": status.export.contentType,
          "content-length": status.export.sizeBytes,
          "content-disposition": `attachment; filename="selfbench-${runMatch[1]}.tar.gz"`,
          "x-content-sha256": status.export.sha256,
        });
        await pipeline(body, response);
        return;
      }
      if (runMatch?.[1] && request.method === "GET" && !runMatch[2]) {
        const handle = client.workflow.getHandle(runMatch[1]);
        const status = await queryStatus(handle);
        sendJson(response, 200, status);
        return;
      }
      if (runMatch?.[1] && request.method === "POST" && runMatch[2] === "cancel") {
        await client.workflow.getHandle(runMatch[1]).cancel();
        sendJson(response, 202, { runId: runMatch[1], cancellationRequested: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/runs") {
        const runs: unknown[] = [];
        for await (const execution of client.workflow.list({
          query: "WorkflowType = 'selfBenchRunWorkflow'",
        })) {
          runs.push({
            runId: execution.workflowId,
            status: execution.status.name,
            startedAt: execution.startTime.toISOString(),
            closedAt: execution.closeTime?.toISOString(),
          });
        }
        sendJson(response, 200, runs);
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, {
        error: message,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.apiPort, config.apiHost, resolve);
  });
  return async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await connection.close();
  };
}

export function buildRunRequest(
  config: SelfBenchConfig,
  submission: z.input<typeof submissionSchema>,
): RunRequest {
  const parsed = submissionSchema.parse(submission);
  return runRequestSchema.parse({
    runId: parsed.runId,
    repository: parsed.repository,
    provenance: parsed.provenance,
    candidateCounts: parsed.candidateCounts,
    authoring: {
      provider: "openai-codex",
      model: parsed.authoringModel,
      reasoningEffort: "high",
    },
    version: {
      selfbenchCommit: config.buildCommit ?? parsed.selfbenchCommit,
      executionBackend: config.execution.kind,
      harborEnvironment: config.harborEnvironment,
      sandboxImage: config.execution.image,
      ...(config.execution.kind === "vercel"
        ? { sandboxTimeoutCapMs: config.execution.timeoutCapMs }
        : {}),
      schema: 1,
    },
  });
}

async function queryStatus(
  handle: ReturnType<Client["workflow"]["getHandle"]>,
): Promise<RunStatus | object> {
  try {
    const [status, description] = await Promise.all([handle.query(statusQuery), handle.describe()]);
    if (description.status.name === "RUNNING" || terminalRunPhase(status.phase)) {
      return status;
    }
    const phase = executionPhase(description.status.name);
    return {
      ...status,
      phase,
      ...(phase === "failed" && !status.error
        ? { error: `Temporal workflow ${description.status.name.toLowerCase()}` }
        : {}),
    };
  } catch {
    const description = await handle.describe();
    return {
      runId: description.workflowId,
      phase: executionPhase(description.status.name),
    };
  }
}

function terminalRunPhase(phase: RunPhase): boolean {
  return ["complete", "blocked", "failed", "cancelled"].includes(phase);
}

function executionPhase(status: string): RunPhase {
  switch (status) {
    case "COMPLETED":
      return "complete";
    case "CANCELED":
      return "cancelled";
    case "RUNNING":
      return "queued";
    default:
      return "failed";
  }
}

async function readBody(request: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > limit) {
      throw new Error(`request body exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    return true;
  }
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!supplied) {
    return false;
  }
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

async function sendReviewAsset(response: ServerResponse, pathname: string): Promise<void> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const root = join(projectRoot(import.meta.url), "dist/review");
  const path = join(root, relativePath);
  if (!path.startsWith(`${root}/`)) {
    sendJson(response, 400, { error: "invalid asset path" });
    return;
  }
  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": contentType(path),
      "content-length": body.byteLength,
      "cache-control": pathname === "/" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "asset not found" });
  }
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
