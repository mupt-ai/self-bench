#!/usr/bin/env node

import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runCommand } from "./process.js";
import { collectGitHubPullRequestProvenance, collectRepositoryProvenance } from "./provenance.js";
import { type PolledRunStatus, waitForRun } from "./run-wait.js";

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "up":
    await up(rest);
    break;
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

async function up(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      backend: { type: "string", default: "docker" },
      "modal-config": { type: "string" },
    },
    strict: true,
  });
  if (parsed.values.backend !== "docker" && parsed.values.backend !== "modal") {
    fail('--backend must be "docker" or "modal"');
  }
  if (parsed.values.backend === "docker" && parsed.values["modal-config"] !== undefined) {
    fail("--modal-config requires --backend modal");
  }

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const composeFile = resolve(projectRoot, "compose.yaml");
  const backend = parsed.values.backend;
  const environment = {
    ...process.env,
    SELFBENCH_EXECUTION_BACKEND: backend,
    SELFBENCH_HARBOR_ENVIRONMENT: backend,
    ...(backend === "modal"
      ? {
          SELFBENCH_MODAL_CONFIG_PATH: resolve(
            parsed.values["modal-config"] ?? resolve(homedir(), ".modal.toml"),
          ),
        }
      : {}),
  };

  if (backend === "docker") {
    await runCommand(
      "docker",
      [
        "build",
        "-f",
        resolve(projectRoot, "Dockerfile.sandbox"),
        "-t",
        "selfbench-sandbox:local",
        projectRoot,
      ],
      { env: environment },
    );
  }
  await runCommand("docker", ["compose", "--file", composeFile, "up", "-d", "--build"], {
    env: environment,
  });
  console.log(`SelfBench is running with the ${backend} backend at http://127.0.0.1:8080`);
}

async function run(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string", short: "r" },
      "easy-count": { type: "string" },
      "medium-count": { type: "string" },
      "hard-count": { type: "string" },
      "run-id": { type: "string" },
      model: { type: "string", default: "gpt-5.6-sol" },
      wait: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
    },
    strict: true,
  });
  const repositoryPath = resolve(parsed.values.repo ?? fail("--repo is required"));
  const candidateCounts = {
    easy: nonnegativeInteger(parsed.values["easy-count"] ?? "0", "--easy-count"),
    medium: nonnegativeInteger(parsed.values["medium-count"] ?? "0", "--medium-count"),
    hard: nonnegativeInteger(parsed.values["hard-count"] ?? "0", "--hard-count"),
  };
  const totalCandidates = candidateCounts.easy + candidateCounts.medium + candidateCounts.hard;
  if (totalCandidates < 1 || totalCandidates > 100) {
    fail("the total candidate count must be between 1 and 100");
  }
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
        candidateCounts,
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
  console.log(`SelfBench creates durable tiered Harbor evaluations.

Usage:
  selfbench up [--backend docker|modal] [--modal-config PATH]
  selfbench run --repo PATH [--easy-count N] [--medium-count N] [--hard-count N]
                [--model MODEL] [--run-id ID] [--wait] [--output OUTPUT.tar.gz]
  selfbench status RUN_ID
  selfbench cancel RUN_ID
  selfbench download RUN_ID OUTPUT.tar.gz
  selfbench list

The up command starts the local stack and configures both sandbox execution and Harbor validation for
one backend. Modal uses ~/.modal.toml unless --modal-config overrides it.

The tier counts are candidate authoring budgets, not accepted-task targets. Rejected candidates are not
replaced, and the export contains only accepted tasks. The run command performs only repository metadata
and sanitized provenance upload locally; discovery, authoring, validation, review, and audit run remotely.
--output implies --wait, blocks until completion, and downloads the SHA-256-verified export.`);
}
