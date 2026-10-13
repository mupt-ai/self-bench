import { record } from "./output.js";

export const OPENROUTER_BILLING = "solver/openrouter-billing.json";
const ROUTER = "typesafe/jev-router";
const BASE = "https://openrouter.ai/api/v1";

type Generation = Record<string, unknown> & { id: string };
type Bill = { cost: number; creditsCost: number; byokCost: number; generations: Generation[] };

function charge(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** One leaf's gateway fee plus BYOK provider bill, never an inferred list-rate estimate. */
export function generationCharge(data: Record<string, unknown>): number | undefined {
  const total = charge(data.total_cost);
  const upstream = data.is_byok === true ? charge(data.upstream_inference_cost) : 0;
  return total === undefined || upstream === undefined ? undefined : total + upstream;
}

/** Only Jev's evidenced direct-leaf and zero-container layouts are priced. */
function reconcile(
  outer: Generation[],
  all: Generation[],
  usage: Map<string, { prompt: number; completion: number }>,
): Bill | undefined {
  const roots = new Map(outer.map((row) => [row.request_id, row]));
  if (roots.size !== outer.length) return undefined;
  const children = new Map<unknown, Generation[]>();
  const upstreamIds = new Set<string>();
  let cost = 0;
  let creditsCost = 0;
  let byokCost = 0;
  for (const row of all) {
    const root = roots.get(row.request_id);
    if (!root || row.session_id !== root.session_id) return undefined;
    if (row.router === ROUTER) {
      if (row.id !== root.id) return undefined;
    } else {
      if (row.router != null) return undefined;
      children.set(row.request_id, [...(children.get(row.request_id) ?? []), row]);
    }
    const billed = generationCharge(row);
    if (billed === undefined || typeof row.is_byok !== "boolean") return undefined;
    creditsCost += charge(row.total_cost) ?? 0;
    byokCost += row.is_byok ? (charge(row.upstream_inference_cost) ?? 0) : 0;
    if (typeof row.upstream_id === "string") {
      if (upstreamIds.has(row.upstream_id)) return undefined;
      upstreamIds.add(row.upstream_id);
    }
    if (billed > 0) {
      const providers = Array.isArray(row.provider_responses)
        ? row.provider_responses.map(record)
        : [];
      if (
        typeof row.upstream_id !== "string" ||
        !providers.some((provider) => provider.id === row.upstream_id && provider.status === 200)
      )
        return undefined;
    }
    cost += billed;
  }
  for (const root of outer) {
    const leaf = all.find((row) => row.id === root.id);
    if (!leaf) return undefined;
    const nested = children.get(root.request_id) ?? [];
    const measured = usage.get(root.id);
    if (!measured) return undefined;
    const workers = nested.length ? nested.filter((row) => row.model === root.model) : [leaf];
    if (
      workers.length !== (nested.length === 3 ? 2 : 1) ||
      workers.some(
        (row) =>
          typeof row.native_tokens_prompt !== "number" ||
          typeof row.native_tokens_completion !== "number" ||
          row.native_tokens_prompt < 0 ||
          row.native_tokens_completion < 0,
      ) ||
      measured.prompt <= 0 ||
      measured.completion < 0
    )
      return undefined;
    // Direct calls have one provider response, so cross-check usage exactly. Advisor turns make
    // two worker attempts plus a third advisor request; Pi reports the turn aggregate, not a
    // one-to-one provider token sum, so validate only that both records have sane usage.
    if (
      nested.length === 0 &&
      (workers[0]?.native_tokens_prompt !== measured.prompt ||
        workers[0]?.native_tokens_completion !== measured.completion)
    )
      return undefined;
    if (nested.length === 0) {
      // A zero wrapper is not a free reply. Its child bill may still be indexing.
      if ((generationCharge(leaf) ?? 0) <= 0) return undefined;
    } else if (
      ![1, 3].includes(nested.length) ||
      generationCharge(leaf) !== 0 ||
      leaf.native_tokens_prompt !== 0 ||
      leaf.native_tokens_completion !== 0 ||
      leaf.upstream_id != null ||
      !Array.isArray(leaf.provider_responses) ||
      leaf.provider_responses.length !== 0
    )
      return undefined;
  }
  return Number.isFinite(cost) ? { cost, creditsCost, byokCost, generations: all } : undefined;
}

/**
 * Analytics discovers children, but its rounded usage is never used as the price. Access is the
 * owner's sealed management key, not the worker's account. Discovery stays within sessions
 * proven by complete direct IDs, and every discovered row must match a direct request as well.
 * Two identical settled snapshots reduce indexing races; unknown layouts fail closed.
 */
export async function jevCost(
  outer: Generation[],
  managementKey: string | undefined,
  lookup: (id: string) => Promise<Generation | undefined>,
  usage: Map<string, { prompt: number; completion: number }>,
  fetcher: typeof fetch = fetch,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 5000)),
): Promise<Bill | undefined> {
  if (
    !managementKey ||
    !outer.length ||
    outer.some(
      (row) =>
        row.router !== ROUTER ||
        typeof row.session_id !== "string" ||
        !row.session_id ||
        typeof row.request_id !== "string" ||
        !row.request_id ||
        typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at)),
    )
  )
    return undefined;
  const sessions = [...new Set(outer.map((row) => row.session_id))];
  const start = Math.min(...outer.map((row) => Date.parse(String(row.created_at))));
  // Bound historical recovery too: generation-level analytics supports at most 31 days.
  // A trial's sessions are isolated; a reused session's unrelated requests are rejected below.
  const end = Math.min(
    Date.now(),
    Math.max(...outer.map((row) => Date.parse(String(row.created_at)))) + 86400000,
  );
  if (end <= start || end - start > 30 * 86400000) return undefined;
  let previous = "";
  try {
    // The ordinary /generation retry handles root indexing; give nested ledger entries time too.
    for (let index = 0; index < 6; index++) await pause();
    for (let attempt = 0; attempt < 7; attempt++) {
      const response = await fetcher(`${BASE}/analytics/query`, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          metrics: ["request_count"],
          dimensions: ["generation_id", "session_id"],
          filters: [{ field: "session_id", operator: "in", value: sessions }],
          time_range: {
            start: new Date(start - 1000).toISOString(),
            end: new Date(end).toISOString(),
          },
          limit: 10000,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return undefined;
      const data = record(record(await response.json()).data);
      const metadata = record(data.metadata);
      if (
        !Array.isArray(data.data) ||
        metadata.truncated !== false ||
        metadata.row_count !== data.data.length
      )
        return undefined;
      const rows = data.data.map(record);
      const ids = rows.map((row) => row.generation_id);
      if (
        ids.some((id) => typeof id !== "string" || !/^gen-[A-Za-z0-9-]+$/.test(id)) ||
        new Set(ids).size !== ids.length ||
        rows.some((row) => !sessions.includes(row.session_id))
      )
        return undefined;
      const all: Generation[] = [];
      for (let index = 0; index < ids.length; index += 10) {
        const batch = await Promise.all((ids.slice(index, index + 10) as string[]).map(lookup));
        if (batch.some((row) => !row)) return undefined;
        all.push(...(batch as Generation[]));
      }
      if (
        all.some(
          (row) =>
            rows.find((entry) => entry.generation_id === row.id)?.session_id !== row.session_id,
        )
      )
        return undefined;
      const bill = reconcile(outer, all, usage);
      const fingerprint = JSON.stringify(all.slice().sort((a, b) => a.id.localeCompare(b.id)));
      if (bill && fingerprint === previous) return bill;
      previous = bill ? fingerprint : "";
      if (attempt < 6) await pause();
    }
  } catch {
    // No partial total and no credential/provider response text in logs.
  }
  return undefined;
}
