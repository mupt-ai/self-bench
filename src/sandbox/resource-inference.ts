import type { ResourceLimits } from "./resources.js";

/**
 * A sandbox account's per-sandbox limits, read from the provider with the credential's own key
 * where the provider exposes them, so a new credential gets its plan's real limits without typing
 * them in. `source` says how they were found; `undefined` limits mean the provider gave none.
 */
export interface InferredLimits {
  limits?: ResourceLimits;
  source: string;
}

const DAYTONA_API = "https://app.daytona.io/api";
const TIMEOUT_MS = 10_000;

/** Vercel's fixed limits (validation.ts): at most 32 vCPUs at 2048 MiB each. */
const VERCEL_LIMITS: ResourceLimits = { cpus: 32, memoryMb: 32 * 2048 };

export async function inferResourceLimits(
  kind: string,
  secret: { value: string; tokenId?: string | undefined },
  fetcher: typeof fetch = fetch,
): Promise<InferredLimits> {
  switch (kind) {
    case "daytona":
      return await daytonaLimits(secret.value, fetcher);
    case "vercel":
      return { limits: VERCEL_LIMITS, source: "Vercel's published sandbox limits" };
    case "e2b":
      // E2B serves a team's limits (/unstable/teams/{id}/limits) only to dashboard sign-ins, not
      // API keys. A template build over the memory limit still says so (selfbench_e2b.py).
      return { source: "E2B does not share a team's limits with its API keys" };
    case "modal":
      return { source: "Modal does not publish per-sandbox limits through its API" };
    default:
      return { source: "Not a sandbox credential" };
  }
}

interface DaytonaOrganization {
  maxCpuPerSandbox?: number | null;
  /** GiB. */
  maxMemoryPerSandbox?: number | null;
  /** GiB. */
  maxDiskPerSandbox?: number | null;
}

/**
 * An API key belongs to one organization, whose per-sandbox quotas are in GiB. Its key record
 * (`/api-keys/current`) may name it (`organizationId` is optional in Daytona's API); otherwise the
 * key's organizations are listed, and only a single one is taken, never a guess among several.
 */
async function daytonaLimits(key: string, fetcher: typeof fetch): Promise<InferredLimits> {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetcher(`${DAYTONA_API}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Daytona refused the lookup (${response.status})`);
    return await response.json();
  };
  let organization: DaytonaOrganization;
  try {
    const current = (await get("/api-keys/current")) as { organizationId?: unknown } | null;
    const id = current?.organizationId;
    if (typeof id === "string" && id)
      organization = ((await get(`/organizations/${encodeURIComponent(id)}`)) ??
        {}) as DaytonaOrganization;
    else {
      const listed = await get("/organizations");
      if (!Array.isArray(listed) || listed.length !== 1)
        return { source: "Daytona did not name this key's organization" };
      organization = listed[0] as DaytonaOrganization;
    }
  } catch (error) {
    return {
      source:
        error instanceof Error && error.message.startsWith("Daytona refused")
          ? error.message
          : "Daytona could not be reached",
    };
  }
  const positive = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? value : undefined;
  const cpus = positive(organization.maxCpuPerSandbox);
  const memory = positive(organization.maxMemoryPerSandbox);
  const disk = positive(organization.maxDiskPerSandbox);
  const limits: ResourceLimits = {
    ...(cpus ? { cpus } : {}),
    ...(memory ? { memoryMb: Math.round(memory * 1024) } : {}),
    ...(disk ? { storageMb: Math.round(disk * 1024) } : {}),
  };
  return Object.keys(limits).length
    ? { limits, source: "Daytona organization quotas" }
    : { source: "Daytona returned no per-sandbox quotas" };
}
