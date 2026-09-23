import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ActivityCancelledError,
  ActivityNotFoundError,
  ActivityPausedError,
  ActivityResetError,
  type Client,
} from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ArtifactRef } from "../../contracts/index.js";
import { costSnapshot } from "../../generation/billing/metered-sandbox.js";
import { readSandboxGrant, type SandboxGrant } from "../../sandbox/callback-grant.js";
import {
  type HeartbeatReply,
  jobEventSchema,
  jobFileKey,
  type SandboxJobOutcome,
  uploadRequestSchema,
} from "../../sandbox/jobs.js";
import { readBody, sendJson } from "../http.js";

export interface SandboxRouteOptions {
  readonly secret: string;
  readonly store: ArtifactStore;
  readonly client: Client;
}

const PREFIX = "/api/sandbox/";
const UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * The callback API for started sandbox jobs. A job authenticates with its signed grant and can
 * only upload under its own prefix and heartbeat, finish, or fail its own activity attempt.
 */
export async function handleSandboxRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  options: SandboxRouteOptions,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const grant = readSandboxGrant(token, options.secret);
  if (!grant) {
    sendJson(response, 401, { error: "unauthorized" });
    return true;
  }
  const path = url.pathname.slice(PREFIX.length);
  if (request.method === "POST" && path === "uploads") {
    await startUpload(request, response, grant, options.store);
  } else if (request.method === "PUT" && path.startsWith("files/")) {
    await receiveUpload(request, response, grant, options.store, path.slice("files/".length));
  } else if (request.method === "POST" && path === "events") {
    await handleEvent(request, response, grant, options);
  } else {
    sendJson(response, 404, { error: "not found" });
  }
  return true;
}

/** Where to PUT one output: a signed storage URL, or this API when the store has none. */
async function startUpload(
  request: IncomingMessage,
  response: ServerResponse,
  grant: SandboxGrant,
  store: ArtifactStore,
): Promise<void> {
  const upload = uploadRequestSchema.parse(
    JSON.parse((await readBody(request, 16_384)).toString()),
  );
  const key = jobFileKey(grant.prefix, upload.name);
  const signed = await store.signedWriteUrl?.(key, upload, UPLOAD_TTL_MS);
  sendJson(
    response,
    200,
    signed ?? {
      url: `${PREFIX}files/${upload.name}`,
      headers: { "content-type": upload.contentType, "x-selfbench-sha256": upload.sha256 },
    },
  );
}

/** Stores an upload for stores without signed URLs (the local development store). */
async function receiveUpload(
  request: IncomingMessage,
  response: ServerResponse,
  grant: SandboxGrant,
  store: ArtifactStore,
  name: string,
): Promise<void> {
  const upload = uploadRequestSchema.pick({ name: true, sha256: true, contentType: true }).parse({
    name,
    sha256: request.headers["x-selfbench-sha256"],
    contentType: request.headers["content-type"],
  });
  const directory = await mkdtemp(join(tmpdir(), "selfbench-upload-"));
  try {
    const file = join(directory, "body");
    await pipeline(request, createWriteStream(file));
    const stored = await store.putFile(
      jobFileKey(grant.prefix, upload.name),
      file,
      upload.contentType,
    );
    if (stored.sha256 !== upload.sha256) {
      sendJson(response, 400, { error: "upload does not match its declared sha256" });
      return;
    }
    sendJson(response, 200, { ok: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function handleEvent(
  request: IncomingMessage,
  response: ServerResponse,
  grant: SandboxGrant,
  { client, store }: SandboxRouteOptions,
): Promise<void> {
  const event = jobEventSchema.parse(JSON.parse((await readBody(request, 1024 * 1024)).toString()));
  const taskToken = Buffer.from(grant.taskToken, "base64");
  try {
    if (event.kind === "heartbeat") {
      // The sandbox rides along so a retry can stop this one; the cost feeds progress pages.
      await client.activity.heartbeat(taskToken, {
        sandbox: grant.sandbox,
        cost: costSnapshot(grant.sandbox, event.usage),
      });
    } else if (event.kind === "failed") {
      await client.activity.fail(taskToken, ApplicationFailure.retryable(event.message));
    } else {
      const { kind: _kind, files: declared, ...reported } = event;
      const files: Record<string, ArtifactRef> = {};
      for (const [name, claimed] of Object.entries(declared)) {
        const stored = await store.stat(jobFileKey(grant.prefix, name));
        if (!stored || stored.sha256 !== claimed.sha256 || stored.sizeBytes !== claimed.sizeBytes) {
          sendJson(response, 400, { error: `${name} was not uploaded as declared` });
          return;
        }
        files[name] = { ...stored, contentType: claimed.contentType };
      }
      const outcome: SandboxJobOutcome = {
        ...reported,
        sandbox: grant.sandbox,
        prefix: grant.prefix,
        files,
      };
      await client.activity.complete(taskToken, outcome);
    }
  } catch (error) {
    if (error instanceof ActivityCancelledError) {
      await client.activity.reportCancellation(taskToken).catch(() => undefined);
    } else if (
      !(error instanceof ActivityNotFoundError) &&
      !(error instanceof ActivityPausedError) &&
      !(error instanceof ActivityResetError)
    ) {
      throw error;
    }
    // Cancelled, timed out, retried, or already finished: this sandbox is no longer wanted.
    sendJson(response, 200, { continue: false } satisfies HeartbeatReply);
    return;
  }
  sendJson(response, 200, { continue: true } satisfies HeartbeatReply);
}
