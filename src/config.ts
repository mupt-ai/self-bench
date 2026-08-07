import { z } from "zod";

const environmentSchema = z.object({
  SELFBENCH_API_HOST: z.string().default("127.0.0.1"),
  SELFBENCH_API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SELFBENCH_API_URL: z.string().url().default("http://127.0.0.1:8080"),
  SELFBENCH_API_TOKEN: z.string().min(1).optional(),
  SELFBENCH_ARTIFACT_BACKEND: z.enum(["local", "gcs"]).default("local"),
  SELFBENCH_ARTIFACT_DIR: z.string().default(".selfbench/artifacts"),
  SELFBENCH_GCS_BUCKET: z.string().optional(),
  SELFBENCH_GCS_PREFIX: z.string().default("selfbench"),
  SELFBENCH_EXECUTION_BACKEND: z.enum(["docker", "modal"]).default("docker"),
  SELFBENCH_DOCKER_IMAGE: z.string().default("selfbench-sandbox:local"),
  SELFBENCH_HARBOR_ENVIRONMENT: z.enum(["docker", "modal"]).optional(),
  SELFBENCH_MODAL_APP: z.string().default("selfbench"),
  SELFBENCH_MODAL_ENVIRONMENT: z.string().optional(),
  SELFBENCH_MODAL_IMAGE: z.string().default("node:22-bookworm"),
  SELFBENCH_BUILD_COMMIT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional(),
  ),
  SELFBENCH_ACTIVITY_CONCURRENCY: z.coerce.number().int().min(1).max(100).optional(),
  SELFBENCH_TASK_QUEUE: z.string().default("selfbench-dev"),
  SELFBENCH_TEMPORAL_ADDRESS: z.string().default("127.0.0.1:7233"),
  SELFBENCH_TEMPORAL_NAMESPACE: z.string().default("default"),
  SELFBENCH_TEMPORAL_API_KEY: z.string().optional(),
  SELFBENCH_TEMPORAL_TLS: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
});

export interface SelfBenchConfig {
  readonly apiHost: string;
  readonly apiPort: number;
  readonly apiUrl: string;
  readonly apiToken?: string;
  readonly buildCommit?: string;
  readonly activityConcurrency: number;
  readonly artifact:
    | { readonly kind: "local"; readonly directory: string }
    | { readonly kind: "gcs"; readonly bucket: string; readonly prefix: string };
  readonly execution:
    | { readonly kind: "docker"; readonly image: string }
    | {
        readonly kind: "modal";
        readonly app: string;
        readonly environment?: string;
        readonly image: string;
      };
  readonly harborEnvironment: "docker" | "modal";
  readonly temporal: {
    readonly address: string;
    readonly namespace: string;
    readonly apiKey?: string;
    readonly tls: boolean;
    readonly taskQueue: string;
  };
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

  return {
    apiHost: value.SELFBENCH_API_HOST,
    apiPort: value.SELFBENCH_API_PORT,
    apiUrl: value.SELFBENCH_API_URL,
    ...(value.SELFBENCH_API_TOKEN ? { apiToken: value.SELFBENCH_API_TOKEN } : {}),
    ...(value.SELFBENCH_BUILD_COMMIT
      ? { buildCommit: value.SELFBENCH_BUILD_COMMIT.toLowerCase() }
      : {}),
    activityConcurrency:
      value.SELFBENCH_ACTIVITY_CONCURRENCY ??
      (value.SELFBENCH_EXECUTION_BACKEND === "modal" ? 20 : 1),
    artifact,
    harborEnvironment: value.SELFBENCH_HARBOR_ENVIRONMENT ?? value.SELFBENCH_EXECUTION_BACKEND,
    execution:
      value.SELFBENCH_EXECUTION_BACKEND === "modal"
        ? {
            kind: "modal",
            app: value.SELFBENCH_MODAL_APP,
            image: value.SELFBENCH_MODAL_IMAGE,
            ...(value.SELFBENCH_MODAL_ENVIRONMENT
              ? { environment: value.SELFBENCH_MODAL_ENVIRONMENT }
              : {}),
          }
        : { kind: "docker", image: value.SELFBENCH_DOCKER_IMAGE },
    temporal: {
      address: value.SELFBENCH_TEMPORAL_ADDRESS,
      namespace: value.SELFBENCH_TEMPORAL_NAMESPACE,
      tls: value.SELFBENCH_TEMPORAL_TLS,
      taskQueue: value.SELFBENCH_TASK_QUEUE,
      ...(value.SELFBENCH_TEMPORAL_API_KEY ? { apiKey: value.SELFBENCH_TEMPORAL_API_KEY } : {}),
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}
