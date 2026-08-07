#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256 } from "./hash.js";
import { runCommand } from "./process.js";
import { collectGitHubPullRequestProvenance, collectRepositoryProvenance } from "./provenance.js";
import { type PolledRunStatus, waitForRun } from "./run-wait.js";

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "run":
    await run(rest);
    break;
  case "status":
    await passthrough("GET", `/v1/runs/${requiredArgument(rest, "run ID")}`);
    break;
  case "cancel":
    await passthrough("POST", `/v1/runs/${requiredArgument(rest, "run ID")}/cancel`);
    break;
  case "list":
    await passthrough("GET", "/v1/runs");
    break;
  case "download":
    await download(requiredArgument(rest, "run ID"), rest[1] ?? fail("output path is required"));
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printHelp();
    break;
  default:
    throw new Error(`unknown command: ${command}`);
}

async function run(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string", short: "r" },
      count: { type: "string", short: "n" },
      "reserve-count": { type: "string" },
      "run-id": { type: "string" },
      model: { type: "string", default: "gpt-5.6-sol" },
      wait: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
    },
    strict: true,
  });
  const repositoryPath = resolve(parsed.values.repo ?? fail("--repo is required"));
  const count = positiveInteger(parsed.values.count ?? fail("--count is required"), "--count");
  const reserveCount = nonnegativeInteger(
    parsed.values["reserve-count"] ?? String(count),
    "--reserve-count",
  );
  const runId = parsed.values["run-id"] ?? defaultRunId();
  const [repository, localMessages, selfbenchCommit] = await Promise.all([
    resolveRepository(repositoryPath),
    collectRepositoryProvenance(repositoryPath, process.env.HOME ?? homedir()),
    resolveSelfBenchCommit(),
  ]);
  const githubMessages = await collectGitHubPullRequestProvenance(repository.url);
  const messages = [...localMessages, ...githubMessages];
  if (messages.length === 0) {
    throw new Error("no sanitized local-session or GitHub pull-request provenance was found");
  }
  const corpus = Buffer.from(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  const provenance = await requestJson(`/v1/provenance?runId=${encodeURIComponent(runId)}`, {
    method: "POST",
    body: corpus,
    contentType: "application/x-ndjson",
  });
  const response = await requestJson("/v1/runs", {
    method: "POST",
    body: Buffer.from(
      JSON.stringify({
        runId,
        repository,
        provenance,
        count,
        reserveCount,
        authoringModel: parsed.values.model,
        selfbenchCommit,
      }),
    ),
    contentType: "application/json",
  });
  console.log(
    JSON.stringify(
      {
        ...response,
        provenanceMessages: messages.length,
        localProvenanceMessages: localMessages.length,
        githubPullRequestMessages: githubMessages.length,
      },
      null,
      2,
    ),
  );
  if (!parsed.values.wait && parsed.values.output === undefined) {
    return;
  }
  const status = await waitForRun({
    poll: async () =>
      asPolledRunStatus(
        await requestJson(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" }),
      ),
    onPhase: (current) => {
      console.error(
        JSON.stringify({
          runId,
          phase: current.phase,
          accepted: current.accepted,
          rejected: current.rejected,
        }),
      );
    },
  });
  if (parsed.values.output !== undefined) {
    await download(runId, parsed.values.output);
  } else {
    console.log(JSON.stringify(status, null, 2));
  }
}

async function resolveRepository(path: string): Promise<{ url: string; commit: string }> {
  const [remote, commit] = await Promise.all([
    runCommand("git", ["-C", path, "remote", "get-url", "origin"]),
    runCommand("git", ["-C", path, "rev-parse", "HEAD"]),
  ]);
  return { url: normalizeGitUrl(remote.stdout.trim()), commit: commit.stdout.trim() };
}

function normalizeGitUrl(value: string): string {
  const ssh = /^git@github\.com:(.+)$/.exec(value);
  if (ssh?.[1]) {
    return `https://github.com/${ssh[1]}`;
  }
  if (value.startsWith("https://")) {
    return value;
  }
  throw new Error(`unsupported origin URL: ${value}`);
}

async function resolveSelfBenchCommit(): Promise<string> {
  if (process.env.SELFBENCH_BUILD_COMMIT) {
    return process.env.SELFBENCH_BUILD_COMMIT;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return (await runCommand("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

async function passthrough(method: "GET" | "POST", path: string): Promise<void> {
  console.log(JSON.stringify(await requestJson(path, { method }), null, 2));
}

async function download(runId: string, outputPath: string): Promise<void> {
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
  const destination = resolve(outputPath);
  const body = Buffer.from(await response.arrayBuffer());
  const expectedSha256 = response.headers.get("x-content-sha256");
  if (!expectedSha256 || sha256(body) !== expectedSha256) {
    throw new Error("downloaded export failed its SHA-256 integrity check");
  }
  await writeFile(destination, body, { flag: "wx" });
  console.log(JSON.stringify({ runId, output: destination }, null, 2));
}

async function requestJson(
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

function requiredArgument(args: string[], label: string): string {
  return args[0] ?? fail(`${label} is required`);
}

function asPolledRunStatus(value: Record<string, unknown>): PolledRunStatus {
  if (typeof value.phase !== "string") {
    throw new Error("SelfBench status response is missing its phase");
  }
  return { ...value, phase: value.phase };
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonnegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

function defaultRunId(): string {
  return `sb-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function fail(message: string): never {
  throw new Error(message);
}

function printHelp(): void {
  console.log(`SelfBench creates durable hard-mode Harbor evaluations.

Usage:
  selfbench run --repo PATH --count N [--reserve-count N] [--model MODEL] [--run-id ID]
                [--wait] [--output OUTPUT.tar.gz]
  selfbench status RUN_ID
  selfbench cancel RUN_ID
  selfbench download RUN_ID OUTPUT.tar.gz
  selfbench list

SelfBench intentionally has no easy mode. The run command performs only repository metadata and
sanitized provenance upload locally; discovery, authoring, validation, review, and audit run remotely.
--output implies --wait, blocks until completion, and downloads the SHA-256-verified export.`);
}
