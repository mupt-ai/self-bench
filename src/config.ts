import { z } from "zod";
import {
  EXECUTION_BACKENDS,
  type ExecutionBackend,
  HARBOR_ENVIRONMENTS,
  type HarborEnvironment,
  matchingHarborEnvironment,
} from "./providers.js";
import {
  HOBBY_E2B_TIMEOUT_CAP_MS,
  parseSandboxTimeoutCapText,
  STANDARD_E2B_TIMEOUT_CAP_MS,
  STANDARD_VERCEL_TIMEOUT_CAP_MS,
} from "./sandbox/timeout.js";
import { normalizeE2BDomain, normalizeE2BTemplateReference } from "./setup/e2b/template.js";

const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const environmentSchema = z.object({
  SELFBENCH_API_HOST: z.string().default("127.0.0.1"),
  SELFBENCH_API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SELFBENCH_API_TOKEN: z.string().min(1).optional(),
  SELFBENCH_ARTIFACT_BACKEND: z.enum(["local", "gcs"]).default("local"),
  SELFBENCH_ARTIFACT_DIR: z.string().default(".selfbench/artifacts"),
  SELFBENCH_GCS_BUCKET: z.string().optional(),
  SELFBENCH_GCS_PREFIX: z.string().default("selfbench"),
  SELFBENCH_EXECUTION_BACKEND: z.enum(EXECUTION_BACKENDS).default("docker"),
  SELFBENCH_DOCKER_IMAGE: z.string().default("selfbench-sandbox:local"),
  SELFBENCH_HARBOR_ENVIRONMENT: z.preprocess(
    emptyStringAsUndefined,
    z.enum(HARBOR_ENVIRONMENTS).optional(),
  ),
  SELFBENCH_MODAL_APP: z.string().default("selfbench"),
  SELFBENCH_MODAL_ENVIRONMENT: z.string().optional(),
  SELFBENCH_MODAL_IMAGE: z.string().default("node:22-bookworm"),
  SELFBENCH_VERCEL_IMAGE: z.preprocess(emptyStringAsUndefined, z.string().trim().min(1).optional()),
  // Keep provider-specific validation in its provider branch so stale hosted
  // provider variables cannot break an otherwise unrelated worker.
  SELFBENCH_VERCEL_TIMEOUT_CAP: z.preprocess(emptyStringAsUndefined, z.string().optional()),
  SELFBENCH_E2B_TEMPLATE: z.preprocess(emptyStringAsUndefined, z.string().trim().min(1).optional()),
  SELFBENCH_E2B_TIMEOUT_CAP: z.preprocess(emptyStringAsUndefined, z.string().optional()),
  SELFBENCH_BUILD_COMMIT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional(),
  ),
  SELFBENCH_ACTIVITY_CONCURRENCY: z.preprocess(
    emptyStringAsUndefined,
    z.coerce.number().int().min(1).max(100).optional(),
  ),
  SELFBENCH_TASK_QUEUE: z.string().default("selfbench-dev"),
  SELFBENCH_TEMPORAL_ADDRESS: z.string().default("127.0.0.1:7233"),
  SELFBENCH_TEMPORAL_NAMESPACE: z.string().default("default"),
  SELFBENCH_TEMPORAL_API_KEY: z.string().optional(),
  SELFBENCH_TEMPORAL_TLS: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
});

export interface VercelCredentials {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
}

export interface E2BCredentials {
  readonly apiKey: string;
  readonly domain?: string;
}

type ExecutionConfig =
  | { readonly kind: "docker"; readonly image: string }
  | {
      readonly kind: "modal";
      readonly app: string;
      readonly environment?: string;
      readonly image: string;
    }
  | { readonly kind: "vercel"; readonly image: string; readonly timeoutCapMs: number }
  | { readonly kind: "e2b"; readonly image: string; readonly timeoutCapMs: number };

type WorkerExecutionConfig =
  | Exclude<ExecutionConfig, { readonly kind: "vercel" | "e2b" }>
  | {
      readonly kind: "vercel";
      readonly image: string;
      readonly timeoutCapMs: number;
      readonly credentials: VercelCredentials;
    }
  | {
      readonly kind: "e2b";
      readonly image: string;
      readonly timeoutCapMs: number;
      readonly credentials: E2BCredentials;
    };

const DEFAULT_ACTIVITY_CONCURRENCY = {
  docker: 1,
  modal: 20,
  vercel: 4,
  e2b: 4,
} as const satisfies Record<ExecutionBackend, number>;

export interface SelfBenchConfig {
  readonly apiHost: string;
  readonly apiPort: number;
  readonly apiToken?: string;
  readonly buildCommit?: string;
  readonly activityConcurrency: number;
  readonly artifact:
    | { readonly kind: "local"; readonly directory: string }
    | { readonly kind: "gcs"; readonly bucket: string; readonly prefix: string };
  readonly execution: ExecutionConfig;
  readonly harborEnvironment: HarborEnvironment;
  readonly temporal: {
    readonly address: string;
    readonly namespace: string;
    readonly apiKey?: string;
    readonly tls: boolean;
    readonly taskQueue: string;
  };
}

export interface SelfBenchWorkerConfig extends Omit<SelfBenchConfig, "execution"> {
  readonly execution: WorkerExecutionConfig;
}

export function isDigestPinnedOciImage(image: string): boolean {
  return /^[^@\s]+@sha256:[0-9a-f]{64}$/i.test(image);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SelfBenchConfig {
  const value = environmentSchema.parse(environment);
  if (
    !["127.0.0.1", "::1", "localhost"].includes(value.SELFBENCH_API_HOST) &&
    !value.SELFBENCH_API_TOKEN
  ) {
    throw new Error("SELFBENCH_API_TOKEN is required when the API listens beyond loopback");
  }
  const artifact =
    value.SELFBENCH_ARTIFACT_BACKEND === "gcs"
      ? {
          kind: "gcs" as const,
          bucket: value.SELFBENCH_GCS_BUCKET ?? fail("SELFBENCH_GCS_BUCKET is required for GCS"),
          prefix: value.SELFBENCH_GCS_PREFIX,
        }
      : { kind: "local" as const, directory: value.SELFBENCH_ARTIFACT_DIR };

  const harborEnvironment =
    value.SELFBENCH_HARBOR_ENVIRONMENT ??
    matchingHarborEnvironment(value.SELFBENCH_EXECUTION_BACKEND) ??
    fail(
      `SELFBENCH_HARBOR_ENVIRONMENT is required for ${value.SELFBENCH_EXECUTION_BACKEND} execution`,
    );
  let execution: ExecutionConfig;
  switch (value.SELFBENCH_EXECUTION_BACKEND) {
    case "docker":
      execution = { kind: "docker", image: value.SELFBENCH_DOCKER_IMAGE };
      break;
    case "modal":
      execution = {
        kind: "modal",
        app: value.SELFBENCH_MODAL_APP,
        image: value.SELFBENCH_MODAL_IMAGE,
        ...(value.SELFBENCH_MODAL_ENVIRONMENT
          ? { environment: value.SELFBENCH_MODAL_ENVIRONMENT }
          : {}),
      };
      break;
    case "vercel": {
      const image =
        value.SELFBENCH_VERCEL_IMAGE ??
        fail("SELFBENCH_VERCEL_IMAGE is required for Vercel execution");
      if (!isDigestPinnedOciImage(image)) {
        fail("SELFBENCH_VERCEL_IMAGE must be pinned by sha256 digest");
      }
      execution = {
        kind: "vercel",
        image,
        timeoutCapMs: vercelTimeoutCap(value.SELFBENCH_VERCEL_TIMEOUT_CAP),
      };
      break;
    }
    case "e2b": {
      const image = normalizeE2BTemplateReference(
        value.SELFBENCH_E2B_TEMPLATE ??
          fail(
            "SELFBENCH_E2B_TEMPLATE is required for E2B execution; build the SelfBench template first",
          ),
      );
      if (image === "base") {
        fail("SELFBENCH_E2B_TEMPLATE must reference a custom SelfBench template, not E2B base");
      }
      execution = {
        kind: "e2b",
        image,
        timeoutCapMs: e2bTimeoutCap(value.SELFBENCH_E2B_TIMEOUT_CAP),
      };
      break;
    }
  }

  return {
    apiHost: value.SELFBENCH_API_HOST,
    apiPort: value.SELFBENCH_API_PORT,
    ...(value.SELFBENCH_API_TOKEN ? { apiToken: value.SELFBENCH_API_TOKEN } : {}),
    ...(value.SELFBENCH_BUILD_COMMIT
      ? { buildCommit: value.SELFBENCH_BUILD_COMMIT.toLowerCase() }
      : {}),
    activityConcurrency:
      value.SELFBENCH_ACTIVITY_CONCURRENCY ??
      DEFAULT_ACTIVITY_CONCURRENCY[value.SELFBENCH_EXECUTION_BACKEND],
    artifact,
    harborEnvironment,
    execution,
    temporal: {
      address: value.SELFBENCH_TEMPORAL_ADDRESS,
      namespace: value.SELFBENCH_TEMPORAL_NAMESPACE,
      tls: value.SELFBENCH_TEMPORAL_TLS,
      taskQueue: value.SELFBENCH_TASK_QUEUE,
      ...(value.SELFBENCH_TEMPORAL_API_KEY ? { apiKey: value.SELFBENCH_TEMPORAL_API_KEY } : {}),
    },
  };
}

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SelfBenchWorkerConfig {
  const config = loadConfig(environment);
  switch (config.execution.kind) {
    case "vercel":
      return {
        ...config,
        execution: {
          ...config.execution,
          credentials: vercelCredentials(environment),
        },
      };
    case "e2b":
      return {
        ...config,
        execution: {
          ...config.execution,
          credentials: e2bCredentials(environment),
        },
      };
    default:
      return { ...config, execution: config.execution };
  }
}

function vercelCredentials(environment: NodeJS.ProcessEnv): VercelCredentials {
  const token = environment.VERCEL_TOKEN?.trim();
  const teamId = environment.VERCEL_TEAM_ID?.trim();
  const projectId = environment.VERCEL_PROJECT_ID?.trim();
  if (!token || !teamId || !projectId) {
    fail("VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are required for Vercel execution");
  }
  return { token, teamId, projectId };
}

function e2bCredentials(environment: NodeJS.ProcessEnv): E2BCredentials {
  const apiKey = environment.E2B_API_KEY?.trim();
  if (!apiKey) {
    fail("E2B_API_KEY is required for E2B execution");
  }
  const domain = normalizeE2BDomain(environment.E2B_DOMAIN);
  return { apiKey, ...(domain ? { domain } : {}) };
}

function vercelTimeoutCap(value: string | undefined): number {
  return providerTimeoutCap(value, STANDARD_VERCEL_TIMEOUT_CAP_MS);
}

function e2bTimeoutCap(value: string | undefined): number {
  if (value === undefined) {
    return HOBBY_E2B_TIMEOUT_CAP_MS;
  }
  return providerTimeoutCap(value, STANDARD_E2B_TIMEOUT_CAP_MS);
}

function providerTimeoutCap(value: string | undefined, maximumMs: number): number {
  if (value === undefined) {
    return maximumMs;
  }
  return z.number().int().min(100).max(maximumMs).parse(parseSandboxTimeoutCapText(value));
}

function fail(message: string): never {
  throw new Error(message);
}
