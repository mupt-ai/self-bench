#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { HeartbeatReply, JobFiles } from "../jobs.js";

// Runs one started sandbox job: the command, a heartbeat to the callback API while it runs, then
// every declared output uploaded and `done` reported. The worker holds no connection meanwhile.

interface JobSpec {
  readonly command: readonly string[];
  readonly outputs: readonly { name: string; path: string; contentType: string }[];
  /** A small JSON file inlined into `done` instead of uploaded. */
  readonly result?: string;
}

const WORK = process.env.SELFBENCH_JOB_WORK ?? "/work";
const SPEC_PATH = `${WORK}/.selfbench-job.json`;
const LOG_PATH = `${WORK}/.selfbench-job.log`;
const HEARTBEAT_MS = 60_000;
const MAX_RESULT_BYTES = 256 * 1024;

const token = required("SELFBENCH_JOB_TOKEN");
const base = required("SELFBENCH_JOB_CALLBACK_URL");
const spec = JSON.parse(await readFile(SPEC_PATH, "utf8")) as JobSpec;

const log = createWriteStream(LOG_PATH, { flags: "a" });
const [program, ...args] = spec.command;
const child = spawn(program ?? "true", args, {
  cwd: WORK,
  env: withoutJobVariables(process.env),
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const exited = new Promise<number>((resolve) => {
  child.on("error", (error) => {
    log.write(`[selfbench] could not start the command: ${error.message}\n`);
    resolve(127);
  });
  child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
});

const heartbeat = setInterval(() => {
  void post<HeartbeatReply>({ kind: "heartbeat" })
    .then((reply) => {
      if (reply.continue) return;
      // The activity was cancelled, retried, or timed out: nobody wants this result.
      child.kill("SIGTERM");
      process.exit(0);
    })
    .catch((error: unknown) => log.write(`[selfbench] heartbeat failed: ${message(error)}\n`));
}, HEARTBEAT_MS);

const exitCode = await exited;
clearInterval(heartbeat);
log.write(`[selfbench] command exited with ${exitCode}\n`);
await new Promise<void>((resolve) => log.end(resolve));

try {
  const files: JobFiles = {};
  const outputs = [...spec.outputs, { name: "job.log", path: LOG_PATH, contentType: "text/plain" }];
  for (const output of outputs) {
    const size = await stat(output.path).then(
      (stats) => stats.size,
      () => 0,
    );
    if (size === 0) continue;
    files[output.name] = await upload(output.name, output.path, output.contentType);
  }
  const result = spec.result ? await readResult(spec.result) : undefined;
  await post({ kind: "done", exitCode, files, ...(result !== undefined ? { result } : {}) });
} catch (error) {
  await post({ kind: "failed", message: `sandbox job could not report: ${message(error)}` });
}

async function upload(name: string, path: string, contentType: string) {
  const body = await readFile(path);
  const declared = {
    sha256: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength,
    contentType,
  };
  const target = await post<{ url: string; headers: Record<string, string> }>(
    { ...declared, name },
    "uploads",
  );
  const headers =
    new URL(target.url, base).origin === new URL(base).origin
      ? { ...target.headers, authorization: `Bearer ${token}` }
      : target.headers;
  const response = await withRetries(() =>
    fetch(new URL(target.url, base), { method: "PUT", headers, body }),
  );
  // 412: an earlier try already created the object; `done` checks it holds these bytes.
  if (!response.ok && response.status !== 412) {
    throw new Error(`upload of ${name} failed: ${response.status}`);
  }
  return declared;
}

async function readResult(path: string): Promise<unknown> {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes || bytes.byteLength === 0) return undefined;
  if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error(`${path} is too large to inline`);
  return JSON.parse(bytes.toString("utf8"));
}

async function post<T = unknown>(body: unknown, path = "events"): Promise<T> {
  const response = await withRetries(() =>
    fetch(new URL(`/api/sandbox/${path}`, base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** Retries network errors and 5xx responses; a 4xx answer is final. */
async function withRetries(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await send();
      if (response.status < 500 || attempt >= 5) return response;
    } catch (error) {
      if (attempt >= 5) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000));
  }
}

function withoutJobVariables(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { SELFBENCH_JOB_TOKEN: _token, ...rest } = environment;
  return rest;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
