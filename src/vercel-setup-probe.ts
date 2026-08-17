import { setTimeout as delay } from "node:timers/promises";
import { APIError, Sandbox } from "@vercel/sandbox";
import type { VercelCredentials } from "./config.js";
import { HOBBY_VERCEL_TIMEOUT_CAP_MS, STANDARD_VERCEL_TIMEOUT_CAP_MS } from "./sandbox-timeout.js";

const PROBE_COMMAND_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const ABSENCE_RETRIES = 3;

export interface VercelCapability {
  readonly timeoutCapMs: number;
  readonly timeoutClass: "45m" | "standard";
  readonly checkedAt: string;
}

interface ProbeSandbox {
  readonly name: string;
  runCommand(
    command: string,
    args: string[],
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<{ readonly exitCode: number }>;
  delete(options: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface VercelSandboxProbeApi {
  create(input: {
    readonly token: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly image: string;
    readonly name: string;
    readonly persistent: false;
    readonly resources: { readonly vcpus: 1 };
    readonly signal?: AbortSignal;
    readonly tags: Readonly<Record<string, string>>;
    readonly timeout: number;
  }): Promise<ProbeSandbox>;
  get(input: {
    readonly token: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly name: string;
    readonly resume: false;
    readonly signal?: AbortSignal;
  }): Promise<ProbeSandbox>;
}

export async function probeVercelCapability(
  input: {
    readonly credentials: VercelCredentials;
    readonly image: string;
    readonly signal?: AbortSignal;
  },
  api: VercelSandboxProbeApi = vercelSandboxProbeApi,
): Promise<VercelCapability> {
  try {
    await runProbe(input, STANDARD_VERCEL_TIMEOUT_CAP_MS, api);
    return {
      timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
      timeoutClass: "standard",
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (!isFortyFiveMinuteLimit(error)) {
      throw sanitizeError(error, input.credentials.token);
    }
  }

  try {
    await runProbe(input, HOBBY_VERCEL_TIMEOUT_CAP_MS, api);
  } catch (error) {
    throw sanitizeError(error, input.credentials.token);
  }
  return {
    timeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS,
    timeoutClass: "45m",
    checkedAt: new Date().toISOString(),
  };
}

const vercelSandboxProbeApi: VercelSandboxProbeApi = {
  async create(input) {
    return await Sandbox.create(input);
  },
  async get(input) {
    return await Sandbox.get(input);
  },
};

async function runProbe(
  input: {
    readonly credentials: VercelCredentials;
    readonly image: string;
    readonly signal?: AbortSignal;
  },
  timeoutMs: number,
  api: VercelSandboxProbeApi,
): Promise<void> {
  input.signal?.throwIfAborted();
  const name = `selfbench-setup-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let sandbox: ProbeSandbox | undefined;
  let primaryError: unknown;
  try {
    sandbox = await api.create({
      ...input.credentials,
      image: input.image,
      name,
      persistent: false,
      resources: { vcpus: 1 },
      ...(input.signal ? { signal: input.signal } : {}),
      tags: { selfbench_stage: "setup-probe" },
      timeout: timeoutMs,
    });
    const result = await sandbox.runCommand("true", [], {
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Vercel setup probe exited ${result.exitCode}`);
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  const status = httpStatus(primaryError);
  const recoverMissingHandle =
    sandbox === undefined && primaryError !== undefined && (status === undefined || status >= 500);
  try {
    await cleanupProbe(name, sandbox, recoverMissingHandle, input.credentials, api);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) {
    throw new AggregateError(
      primaryError === undefined ? [cleanupError] : [primaryError, cleanupError],
      `Vercel setup probe ${name} could not be deleted cleanly`,
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

async function cleanupProbe(
  name: string,
  sandbox: ProbeSandbox | undefined,
  recoverMissingHandle: boolean,
  credentials: VercelCredentials,
  api: VercelSandboxProbeApi,
): Promise<void> {
  let directDeleteError: unknown;
  if (sandbox) {
    try {
      await sandbox.delete({ signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
      await confirmAbsent(name, credentials, api);
      return;
    } catch (error) {
      directDeleteError = error;
    }
  } else if (!recoverMissingHandle) {
    return;
  }

  try {
    await confirmAbsent(name, credentials, api);
  } catch (recoveryError) {
    throw new AggregateError(
      directDeleteError === undefined ? [recoveryError] : [directDeleteError, recoveryError],
      `failed to recover Vercel setup probe ${name} by exact name`,
    );
  }
}

async function confirmAbsent(
  name: string,
  credentials: VercelCredentials,
  api: VercelSandboxProbeApi,
): Promise<void> {
  for (let attempt = 0; attempt < ABSENCE_RETRIES; attempt += 1) {
    try {
      const recovered = await api.get({
        ...credentials,
        name,
        resume: false,
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
      await recovered.delete({ signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    } catch (error) {
      if (httpStatus(error) === 404) {
        return;
      }
      throw error;
    }
    await delay(250 * (attempt + 1));
  }
  throw new Error(`Vercel setup probe ${name} still exists after deletion`);
}

function isFortyFiveMinuteLimit(error: unknown): boolean {
  return (
    httpStatus(error) === 400 &&
    /`?timeout`?.*(?:should be|must be).*<=\s*45m/i.test(errorDetail(error))
  );
}

function httpStatus(error: unknown): number | undefined {
  if (error instanceof APIError) {
    return error.response.status;
  }
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

function errorDetail(error: unknown): string {
  if (error instanceof APIError) {
    return [error.message, error.text, JSON.stringify(error.json)].filter(Boolean).join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}

function sanitizeError(error: unknown, token: string): Error {
  const sanitized = new Error(errorDetail(error).replaceAll(token, "[redacted]").slice(0, 2_000));
  sanitized.name = error instanceof Error ? error.name : "VercelSetupError";
  return sanitized;
}
