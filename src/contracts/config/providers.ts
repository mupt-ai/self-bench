export const EXECUTION_BACKENDS = ["docker", "modal", "vercel", "e2b"] as const;
export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];
export const executionBackendLabels = {
  docker: "Docker",
  modal: "Modal",
  vercel: "Vercel",
  e2b: "E2B",
} as const satisfies Record<ExecutionBackend, string>;

/** Harbor `--env` values the pinned Harbor build supports that SelfBench can credential. */
export const HARBOR_ENVIRONMENTS = ["docker", "modal", "vercel", "e2b", "daytona"] as const;
export type HarborEnvironment = (typeof HARBOR_ENVIRONMENTS)[number];
export const harborEnvironmentLabels = {
  docker: "Docker",
  modal: "Modal",
  vercel: "Vercel",
  e2b: "E2B",
  daytona: "Daytona",
} as const satisfies Record<HarborEnvironment, string>;

/**
 * Backends the hosted site offers for generation. Docker runs sandboxes on the
 * Temporal worker itself, so it is reserved for the local CLI stack.
 */
export const HOSTED_EXECUTION_BACKENDS = ["modal", "vercel", "e2b"] as const;
export type HostedExecutionBackend = (typeof HOSTED_EXECUTION_BACKENDS)[number];
/**
 * Harbor environments that run a task's `docker-compose.yaml`, and so its sidecar services. Harbor
 * 0.23.0's E2B environment builds only the Dockerfile and silently drops the compose file.
 */
const COMPOSE_HARBOR_ENVIRONMENTS: ReadonlySet<HarborEnvironment> = new Set([
  "docker",
  "modal",
  "vercel",
  "daytona",
]);

export function harborRunsServices(environment: HarborEnvironment): boolean {
  return COMPOSE_HARBOR_ENVIRONMENTS.has(environment);
}

/** Harbor environments the hosted site offers; Docker Harbor would also run on the worker. */
export const HOSTED_HARBOR_ENVIRONMENTS = ["modal", "vercel", "e2b", "daytona"] as const;
export type HostedHarborEnvironment = (typeof HOSTED_HARBOR_ENVIRONMENTS)[number];

const harborEnvironments: ReadonlySet<string> = new Set(HARBOR_ENVIRONMENTS);

export function isHarborEnvironment(value: string): value is HarborEnvironment {
  return harborEnvironments.has(value);
}

export function matchingHarborEnvironment(
  backend: ExecutionBackend,
): HarborEnvironment | undefined {
  return isHarborEnvironment(backend) ? backend : undefined;
}

export function isDigestPinnedOciImage(image: string): boolean {
  return /^[^@\s]+@sha256:[0-9a-f]{64}$/i.test(image);
}
