export const EXECUTION_BACKENDS = ["docker", "modal", "vercel", "e2b"] as const;
export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];

export const HARBOR_ENVIRONMENTS = ["docker", "modal"] as const;
export type HarborEnvironment = (typeof HARBOR_ENVIRONMENTS)[number];

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
