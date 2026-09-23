import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityCancelledError, type Client } from "@temporalio/client";
import { sendApiError } from "../../src/api/http.js";
import { handleSandboxRoute } from "../../src/api/routes/sandbox.js";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { runCommand } from "../../src/lib/process.js";
import { signSandboxGrant } from "../../src/sandbox/callback-grant.js";
import type { SandboxJobOutcome } from "../../src/sandbox/jobs.js";

const secret = "s".repeat(32);
const sandbox = {
  sandboxId: "sb-1",
  stage: "compile-c",
  startedAt: "2026-09-23T00:00:00.000Z",
  expiresAt: "2026-09-23T01:00:00.000Z",
};
const prefix = "runs/r/verify/c/authoring-round-1/compile/attempt-1";
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-callback-"));
  roots.push(root);
  return root;
}

/** The callback API on a real HTTP server, with a Temporal client that records its calls. */
async function callbackApi(store: LocalArtifactStore, cancelled = false) {
  const calls: { kind: string; value?: unknown }[] = [];
  const record = (kind: string) => async (_token: Uint8Array, value?: unknown) => {
    calls.push({ kind, value });
    if (cancelled && kind === "heartbeat") throw new ActivityCancelledError("cancelled");
  };
  const client = {
    activity: {
      heartbeat: record("heartbeat"),
      complete: record("complete"),
      fail: record("fail"),
      reportCancellation: record("reportCancellation"),
    },
  } as unknown as Client;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!(await handleSandboxRoute(request, url, response, { secret, store, client }))) {
        response.writeHead(404).end();
      }
    } catch (error) {
      sendApiError(response, error);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls };
}

function token(expiresAt = Date.now() + 60_000): string {
  return signSandboxGrant(
    { taskToken: Buffer.from("task").toString("base64"), prefix, sandbox, expiresAt },
    secret,
  );
}

/** Runs the real job runner in `work` with `spec`, reporting to `base`. */
async function runJob(work: string, base: string, spec: object): Promise<void> {
  await writeFile(join(work, ".selfbench-job.json"), JSON.stringify(spec));
  await runCommand(process.execPath, [join(import.meta.dir, "../../src/sandbox/programs/job.ts")], {
    env: {
      ...process.env,
      SELFBENCH_JOB_WORK: work,
      SELFBENCH_JOB_TOKEN: token(),
      SELFBENCH_JOB_CALLBACK_URL: base,
      SELFBENCH_JOB_DEADLINE: new Date(Date.now() + 60_000).toISOString(),
    },
  });
}

test("a job uploads its outputs and completes its activity with references to them", async () => {
  const store = new LocalArtifactStore(await temporary());
  const { base, calls } = await callbackApi(store);
  const work = await temporary();

  await runJob(work, base, {
    command: [
      "bash",
      "-c",
      "echo building; printf bundle > out.tar.gz; echo '{\"compileErrors\":[]}' > result.json",
    ],
    outputs: [
      { name: "harbor-task.tar.gz", path: `${work}/out.tar.gz`, contentType: "application/gzip" },
      { name: "missing.txt", path: `${work}/missing.txt`, contentType: "text/plain" },
    ],
    inline: [{ name: "result.json", path: `${work}/result.json` }],
    log: "compile.log",
  });

  expect(calls.map((call) => call.kind)).toEqual(["complete"]);
  const outcome = calls[0]?.value as SandboxJobOutcome;
  expect(outcome.sandbox).toEqual(sandbox);
  expect(outcome.prefix).toBe(prefix);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.inline).toEqual({ "result.json": { compileErrors: [] } });
  expect(Object.keys(outcome.files).sort()).toEqual(["compile.log", "harbor-task.tar.gz"]);
  const bundle = outcome.files["harbor-task.tar.gz"];
  if (!bundle) throw new Error("bundle missing");
  expect(Buffer.from(await store.get(bundle)).toString()).toBe("bundle");
  const log = await readFile(new URL(outcome.files["compile.log"]?.uri ?? ""), "utf8");
  expect(log).toContain("building");
});

test("an agent job publishes its live feed and reports usage and its last message", async () => {
  const store = new LocalArtifactStore(await temporary());
  const { base, calls } = await callbackApi(store);
  const work = await temporary();
  const events = [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working" } },
    { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5 } } },
  ];
  const session = { type: "message", message: { role: "assistant", content: "All done" } };
  await writeFile(
    join(work, "events.jsonl"),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  await writeFile(join(work, "session.jsonl"), `${JSON.stringify(session)}\n`);

  await runJob(work, base, {
    command: ["bash", "-c", "cat events.jsonl; mkdir -p out; echo '{}' > out/verdict.json"],
    outputs: [
      {
        name: "out/verdict.json",
        path: `${work}/out/verdict.json`,
        contentType: "application/json",
      },
    ],
    log: "sandbox.log",
    delivers: [[`${work}/out/verdict.json`, `${work}/session.jsonl`]],
    agent: { live: "live", redact: [], session: `${work}/session.jsonl` },
  });

  const outcome = calls.at(-1)?.value as SandboxJobOutcome;
  expect(calls.at(-1)?.kind).toBe("complete");
  expect(outcome.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, messages: 1 });
  expect(outcome.finalMessage).toBe("All done");
  expect(Object.keys(outcome.files)).toContain("out/verdict.json");
  const snapshot = await store.getByKey(`${prefix}/live/00000000.json`);
  expect(JSON.parse(Buffer.from(snapshot ?? []).toString()).events).toEqual([
    { kind: "message", text: "Working" },
  ]);
});

test("an agent that delivered nothing fails its attempt so Temporal retries it", async () => {
  const store = new LocalArtifactStore(await temporary());
  const { base, calls } = await callbackApi(store);
  const work = await temporary();

  await runJob(work, base, {
    command: ["bash", "-c", "exit 3"],
    outputs: [],
    log: "sandbox.log",
    delivers: [[`${work}/verdict.json`]],
    agent: { live: "live", redact: [], session: `${work}/session.jsonl` },
  });

  expect(calls.map((call) => call.kind)).toEqual(["fail"]);
  expect(String(calls[0]?.value)).toContain("nothing delivered (exit 3)");
  expect(await store.stat(`${prefix}/sandbox.log`)).toBeDefined();
});

test("the API rejects forged or expired grants and results that were never uploaded", async () => {
  const store = new LocalArtifactStore(await temporary());
  const { base, calls } = await callbackApi(store);
  const post = (bearer: string, body: unknown) =>
    fetch(`${base}/api/sandbox/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });

  expect((await post("forged.token", { kind: "heartbeat" })).status).toBe(401);
  expect((await post(token(Date.now() - 1), { kind: "heartbeat" })).status).toBe(401);
  const claimed = { sha256: "a".repeat(64), sizeBytes: 3, contentType: "text/plain" };
  const done = await post(token(), { kind: "done", exitCode: 0, files: { "x.txt": claimed } });
  expect(done.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a cancelled activity tells its sandbox to stop and reports the cancellation", async () => {
  const store = new LocalArtifactStore(await temporary());
  const { base, calls } = await callbackApi(store, true);
  const reply = await fetch(`${base}/api/sandbox/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
    body: JSON.stringify({ kind: "heartbeat" }),
  });
  expect(await reply.json()).toEqual({ continue: false });
  expect(calls.map((call) => call.kind)).toEqual(["heartbeat", "reportCancellation"]);
  expect(calls[0]?.value).toEqual({
    sandbox,
    cost: expect.objectContaining({ stage: sandbox.stage, state: "unknown" }),
  });
});
