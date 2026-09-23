#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PiEventFeed } from "../../harnesses/pi/event-feed.js";
import { finalAssistantMessage, sessionProviderError } from "../../harnesses/pi/session.js";
import { PiUsageMeter } from "../../harnesses/pi/usage-meter.js";
import { CallbackClient } from "../job-runner/client.js";
import { JOB_DEADLINE_VARIABLE, JOB_SPEC_FILE, type JobSpec } from "../job-runner/spec.js";
import type { HeartbeatReply, JobDone } from "../jobs.js";

// Runs one started sandbox job: the command, a heartbeat to the callback API while it runs, then
// every declared output uploaded and `done` reported. The worker holds no connection meanwhile.

const HEARTBEAT_MS = 60_000;
const LIVE_MS = 5_000;
const MAX_INLINE_BYTES = 256 * 1024;

const WORK = process.env.SELFBENCH_JOB_WORK ?? "/work";
const LOG_PATH = join(WORK, ".selfbench-job.log");
const client = new CallbackClient(
  required("SELFBENCH_JOB_CALLBACK_URL"),
  required("SELFBENCH_JOB_TOKEN"),
);
const spec = JSON.parse(await readFile(join(WORK, JOB_SPEC_FILE), "utf8")) as JobSpec;
const agent = spec.agent;
const feed =
  agent && new PiEventFeed(agent.redact.map((name) => process.env[name] ?? "").filter(Boolean));
const meter = agent && new PiUsageMeter();

const log = createWriteStream(LOG_PATH, { flags: "a" });
const [program, ...args] = spec.command;
const { SELFBENCH_JOB_TOKEN: _token, ...environment } = process.env;
const child = spawn(program ?? "true", args, {
  cwd: WORK,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
let failure: string | undefined;
let idle: NodeJS.Timeout | undefined;
const stopCommand = (reason: string) => {
  failure ??= reason;
  child.kill("SIGKILL");
};
const touch = () => {
  if (!spec.inactivityMs) return;
  clearTimeout(idle);
  idle = setTimeout(() => stopCommand(`no output for ${spec.inactivityMs} ms`), spec.inactivityMs);
};
child.stdout.on("data", (chunk: Buffer) => {
  log.write(chunk);
  feed?.push(chunk);
  meter?.push(chunk);
  touch();
});
child.stderr.on("data", (chunk: Buffer) => {
  log.write(chunk);
  touch();
});
touch();
const deadline = setTimeout(
  () => stopCommand("timed out"),
  Math.max(0, Date.parse(required(JOB_DEADLINE_VARIABLE)) - Date.now()),
);
const exited = new Promise<number>((resolve) => {
  child.on("error", (error) => {
    log.write(`[selfbench] could not start the command: ${error.message}\n`);
    resolve(127);
  });
  child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
});

const heartbeat = setInterval(() => {
  void client
    .post<HeartbeatReply>({ kind: "heartbeat", ...(meter ? { usage: meter.usage() } : {}) })
    .then((reply) => {
      if (reply.continue) return;
      // The activity was cancelled, retried, or timed out: nobody wants this result.
      child.kill("SIGKILL");
      process.exit(0);
    })
    .catch((error: unknown) => log.write(`[selfbench] heartbeat failed: ${message(error)}\n`));
}, HEARTBEAT_MS);

let published = "";
let sequence = 0;
/** Uploads the redacted feed when it changed, as immutable numbered snapshots. */
const publishLive = async () => {
  if (!feed || !agent) return;
  const events = feed.events();
  const snapshot = JSON.stringify(events);
  if (events.length === 0 || snapshot === published) return;
  const body = Buffer.from(JSON.stringify({ events, capturedAt: new Date().toISOString() }));
  const name = `${agent.live}/${String(sequence).padStart(8, "0")}.json`;
  await client.upload(name, body, "application/json");
  published = snapshot;
  sequence += 1;
};
let publishing = Promise.resolve();
const live = setInterval(() => {
  publishing = publishing.then(publishLive).catch((error: unknown) => {
    log.write(`[selfbench] live feed upload failed: ${message(error)}\n`);
  });
}, LIVE_MS);

const exitCode = await exited;
clearInterval(heartbeat);
clearInterval(live);
clearTimeout(deadline);
clearTimeout(idle);
log.write(`[selfbench] command exited with ${exitCode}\n`);
await new Promise<void>((resolve) => log.end(resolve));
await publishing;
await publishLive().catch(() => undefined);

try {
  const files: JobDone["files"] = {};
  files[spec.log] = await client.uploadFile(spec.log, LOG_PATH, "text/plain");
  if (failure) throw new Error(`${failure}; log uploaded as ${spec.log}`);
  const session = agent ? await readFile(agent.session).catch(() => undefined) : undefined;
  const providerError = session && sessionProviderError(session)?.slice(0, 4_000);
  const delivered = await someDelivered(spec.delivers ?? []);
  const broken = exitCode !== 0 || providerError || (agent && !session) || spec.requireDelivery;
  if (!delivered && broken) {
    throw new Error(
      `nothing delivered (exit ${exitCode}${providerError ? `, provider: ${providerError.slice(0, 200)}` : ""}); log uploaded as ${spec.log}`,
    );
  }
  for (const output of spec.outputs) {
    const size = await stat(output.path).then(
      (stats) => stats.size,
      () => 0,
    );
    if (size > 0) {
      files[output.name] = await client.uploadFile(output.name, output.path, output.contentType);
    }
  }
  const inline: JobDone["inline"] = {};
  for (const item of spec.inline ?? []) {
    const bytes = await readFile(item.path).catch(() => undefined);
    if (!bytes?.byteLength) continue;
    if (bytes.byteLength > MAX_INLINE_BYTES) throw new Error(`${item.path} is too large to inline`);
    inline[item.name] = JSON.parse(bytes.toString("utf8"));
  }
  const finalMessage = session && finalAssistantMessage(session)?.slice(0, 4_000);
  await client.post({
    kind: "done",
    exitCode,
    files,
    inline,
    ...(meter ? { usage: meter.usage() } : {}),
    ...(finalMessage ? { finalMessage } : {}),
    ...(providerError ? { providerError } : {}),
  });
} catch (error) {
  await client.post({ kind: "failed", message: `sandbox job failed: ${message(error)}` });
}

async function someDelivered(sets: readonly (readonly string[])[]): Promise<boolean> {
  for (const paths of sets) {
    const sizes = await Promise.all(
      paths.map((path) =>
        stat(path).then(
          (stats) => stats.size,
          () => 0,
        ),
      ),
    );
    if (sizes.every((size) => size > 0)) return true;
  }
  return false;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
