import { z } from "zod";
import type { RegistryDataset } from "../../contracts/harbor-registry.js";

/**
 * Harbor's registry has no documented listing API: its hub and its CLI both read the package
 * tables from Harbor's Supabase project with a publishable (read-only, public) key. These are the
 * CLI's own defaults (harbor/auth/constants.py), overridable by the same variables it reads.
 */
const DEFAULT_SUPABASE_URL = "https://ofhuhcpkvzjlejydnvyd.supabase.co";
const DEFAULT_PUBLISHABLE_KEY = "sb_publishable_Z-vuQbpvpG-PStjbh4yE0Q_e-d3MTIH";

/** How long one listing serves the add box before the next request refreshes it. */
const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 15_000;

/** Every public dataset package, with its newest unyanked version's description and task count. */
const QUERY = new URLSearchParams({
  select: "name,org:org_id(name),dataset_version(description,dataset_version_task(count))",
  type: "eq.dataset",
  visibility: "eq.public",
  is_temporary: "eq.false",
  "dataset_version.yanked_at": "is.null",
  "dataset_version.order": "revision.desc",
  "dataset_version.limit": "1",
});

const rowsSchema = z.array(
  z.object({
    name: z.string(),
    org: z.object({ name: z.string() }).nullable(),
    dataset_version: z.array(
      z.object({
        description: z.string().nullable(),
        dataset_version_task: z.array(z.object({ count: z.number() })),
      }),
    ),
  }),
);

/** The public datasets in Harbor's registry, by name. Datasets with no live version are left out. */
export async function fetchRegistryDatasets(
  env: NodeJS.ProcessEnv,
  call: typeof fetch = fetch,
): Promise<RegistryDataset[]> {
  const base = env.HARBOR_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
  const key = env.HARBOR_SUPABASE_PUBLISHABLE_KEY ?? DEFAULT_PUBLISHABLE_KEY;
  if (!base.startsWith("https://")) throw new Error("Harbor's registry URL must use HTTPS");
  const response = await call(`${base}/rest/v1/package?${QUERY}`, {
    headers: { apikey: key, accept: "application/json" },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Harbor's registry answered ${response.status}`);
  const datasets: RegistryDataset[] = [];
  for (const row of rowsSchema.parse(await response.json())) {
    const version = row.dataset_version[0];
    if (!row.org || !version) continue;
    const description = version.description?.trim();
    datasets.push({
      name: `${row.org.name}/${row.name}`,
      ...(description ? { description } : {}),
      tasks: version.dataset_version_task[0]?.count ?? 0,
    });
  }
  return datasets.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The listing, kept for a while so the add box opens at once and Harbor sees one request per
 * period rather than one per visitor. A failed refresh keeps serving the last good listing.
 */
export function registryCatalog(
  load: () => Promise<RegistryDataset[]>,
  now: () => number = Date.now,
): () => Promise<RegistryDataset[]> {
  let kept: { datasets: RegistryDataset[]; at: number } | undefined;
  let pending: Promise<RegistryDataset[]> | undefined;
  return async () => {
    if (kept && now() - kept.at < CATALOG_TTL_MS) return kept.datasets;
    pending ??= load()
      .then((datasets) => {
        kept = { datasets, at: now() };
        return datasets;
      })
      .finally(() => {
        pending = undefined;
      });
    try {
      return await pending;
    } catch (error) {
      if (kept) return kept.datasets;
      throw error;
    }
  };
}

/** The catalog production serves: Harbor's listing, cached, read with this process's environment. */
export function productionRegistryCatalog(env: NodeJS.ProcessEnv = process.env) {
  return registryCatalog(() => fetchRegistryDatasets(env));
}
