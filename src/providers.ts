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
/** Harbor environments the hosted site offers; Docker Harbor would also run on the worker. */
export const HOSTED_HARBOR_ENVIRONMENTS = ["modal", "vercel", "e2b", "daytona"] as const;
export type HostedHarborEnvironment = (typeof HOSTED_HARBOR_ENVIRONMENTS)[number];

const executionBackends: ReadonlySet<string> = new Set(EXECUTION_BACKENDS);
const harborEnvironments: ReadonlySet<string> = new Set(HARBOR_ENVIRONMENTS);

export function isExecutionBackend(value: string): value is ExecutionBackend {
  return executionBackends.has(value);
}

export function isHarborEnvironment(value: string): value is HarborEnvironment {
  return harborEnvironments.has(value);
}

export function matchingHarborEnvironment(
  backend: ExecutionBackend,
): HarborEnvironment | undefined {
  return isHarborEnvironment(backend) ? backend : undefined;
}
