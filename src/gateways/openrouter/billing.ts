import { record, TRUNCATED_OUTPUT } from "../../evaluation/output.js";
import type { Harness } from "../../evaluation/types.js";
import {
  billingPause,
  type Generation,
  generationCharge,
  generationLookup,
  lookupGenerations,
  type Pause,
} from "../billing.js";
import { gatewayUsage, generationIds, readGatewayManifest } from "../usage.js";

export const OPENROUTER_BILLING = "solver/openrouter-billing.json";
export const OPENROUTER_GENERATIONS = "solver/openrouter-generation-ids.json";
const BASE = "https://openrouter.ai/api/v1";
type Bill = { cost: number; creditsCost: number; byokCost: number; generations: Generation[] };

/** Preserve accounting IDs before the archived transcript is shortened. */
export function openRouterManifest(
  harness: Harness,
  records: Map<string, string>,
  clean: Map<string, string>,
): void {
  if (
    [...records].some(
      ([name, text]) => name.endsWith("/pi.txt") && text.startsWith(TRUNCATED_OUTPUT),
    )
  )
    return;
  const ids = generationIds(harness, records);
  if (!ids) return;
  const usage = gatewayUsage(records);
  const manifest = JSON.stringify({
    generationIds: ids,
    usage: [...usage].map(([id, tokens]) => ({ id, ...tokens })),
  });
  clean.set(OPENROUTER_GENERATIONS, manifest);
  records.set(OPENROUTER_GENERATIONS, manifest);
}

export async function openRouterCost(
  harness: Harness,
  files: Map<string, string>,
  key: string,
  managementKey?: string,
  fetcher: typeof fetch = fetch,
  pause: Pause = billingPause,
): Promise<number | undefined> {
  files.delete(OPENROUTER_BILLING);
  if (harness !== "pi") return undefined;
  const saved = files.get(OPENROUTER_GENERATIONS);
  const manifest = saved ? readGatewayManifest(saved) : undefined;
  if (saved && !manifest) return undefined;
  if (
    !manifest &&
    [...files].some(([name, text]) => name.endsWith("/pi.txt") && text.startsWith(TRUNCATED_OUTPUT))
  )
    return undefined;
  const ids = manifest?.generationIds ?? generationIds(harness, files);
  if (!ids) return undefined;
  const bill = await openRouterBill(
    ids,
    key,
    manifest?.usage ?? gatewayUsage(files),
    managementKey,
    fetcher,
    pause,
  );
  if (!bill) return undefined;
  files.set(OPENROUTER_BILLING, JSON.stringify(bill));
  return bill.cost;
}

function total(generations: Generation[]): Bill | undefined {
  let cost = 0;
  let creditsCost = 0;
  let byokCost = 0;
  const upstreamIds = new Set<string>();
  for (const row of generations) {
    const billed = generationCharge(row);
    if (billed === undefined) return undefined;
    if (typeof row.upstream_id === "string") {
      if (upstreamIds.has(row.upstream_id)) return undefined;
      upstreamIds.add(row.upstream_id);
    }
    cost += billed;
    creditsCost += Number(row.total_cost);
    byokCost += row.is_byok === true ? Number(row.upstream_inference_cost) : 0;
  }
  return Number.isFinite(cost) ? { cost, creditsCost, byokCost, generations } : undefined;
}

/** Every discovered charge must belong to a retained client request and its session. */
function reconcile(direct: Generation[], all: Generation[]): Bill | undefined {
  const roots = new Map(direct.map((row) => [row.request_id, row]));
  if (roots.size !== direct.length || new Set(all.map((row) => row.id)).size !== all.length)
    return undefined;
  const groups = new Map<unknown, Generation[]>();
  for (const row of all) {
    const root = roots.get(row.request_id);
    if (!root || root.session_id !== row.session_id || typeof row.is_byok !== "boolean")
      return undefined;
    groups.set(row.request_id, [...(groups.get(row.request_id) ?? []), row]);
  }
  for (const root of direct) {
    const group = groups.get(root.request_id) ?? [];
    const parent = group.find((row) => row.id === root.id);
    if (!parent) return undefined;
    if (group.length === 1) {
      // A router container may still be awaiting its child ledger, even with stable analytics.
      if (
        parent.router != null &&
        generationCharge(parent) === 0 &&
        parent.native_tokens_prompt === 0 &&
        parent.native_tokens_completion === 0
      )
        return undefined;
    } else {
      // Positive parent charges might be aggregates of children. Without a billing contract we
      // cannot safely add both. Accept only empty containers and individually billed leaves.
      for (const row of group.filter((row) => row.router != null || row.id === root.id)) {
        if (
          generationCharge(row) !== 0 ||
          row.native_tokens_prompt !== 0 ||
          row.native_tokens_completion !== 0 ||
          row.upstream_id != null ||
          !Array.isArray(row.provider_responses) ||
          row.provider_responses.length !== 0
        )
          return undefined;
      }
      const leaves = group.filter((row) => row.id !== root.id && row.router == null);
      if (!leaves.length) return undefined;
      for (const leaf of leaves) {
        if (
          typeof leaf.native_tokens_prompt !== "number" ||
          leaf.native_tokens_prompt < 0 ||
          typeof leaf.native_tokens_completion !== "number" ||
          leaf.native_tokens_completion < 0 ||
          generationCharge(leaf) === undefined ||
          typeof leaf.upstream_id !== "string" ||
          !Array.isArray(leaf.provider_responses) ||
          !leaf.provider_responses
            .map(record)
            .some((provider) => provider.id === leaf.upstream_id && provider.status === 200)
        )
          return undefined;
      }
    }
  }
  return total(all);
}

async function discover(
  direct: Generation[],
  managementKey: string,
  lookup: (id: string) => Promise<Generation | undefined>,
  fetcher: typeof fetch,
  pause: Pause,
): Promise<Bill | undefined> {
  if (
    direct.some(
      (row) =>
        typeof row.session_id !== "string" ||
        !row.session_id ||
        typeof row.request_id !== "string" ||
        !row.request_id ||
        typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at)),
    )
  )
    return undefined;
  const sessions = [...new Set(direct.map((row) => row.session_id))];
  const start = Math.min(...direct.map((row) => Date.parse(String(row.created_at)))) - 1000;
  const end = Math.min(
    Date.now(),
    Math.max(...direct.map((row) => Date.parse(String(row.created_at)))) + 86400000,
  );
  if (end <= start || end - start > 31 * 86400000) return undefined;
  let previous = "";
  try {
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
          time_range: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
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
        !ids.every(
          (id): id is string =>
            typeof id === "string" && /^(gen_[A-Za-z0-9]+|gen-[A-Za-z0-9-]+)$/.test(id),
        ) ||
        new Set(ids).size !== ids.length ||
        rows.some((row) => !sessions.includes(row.session_id))
      )
        return undefined;
      const all = await lookupGenerations(ids, lookup);
      if (
        !all ||
        all.some(
          (row) =>
            rows.find((entry) => entry.generation_id === row.id)?.session_id !== row.session_id,
        )
      )
        return undefined;
      const bill = reconcile(direct, all);
      const fingerprint = JSON.stringify(all.slice().sort((a, b) => a.id.localeCompare(b.id)));
      if (bill && fingerprint === previous) return bill;
      previous = bill ? fingerprint : "";
      if (attempt < 6) await pause();
    }
  } catch {
    // An unavailable ledger is not a free request or a partial bill.
  }
  return undefined;
}

/** Exact generation charges, with session-ledger discovery for any routed request. */
async function openRouterBill(
  ids: string[],
  key: string,
  usage: Map<string, { prompt: number; completion: number }>,
  managementKey?: string,
  fetcher: typeof fetch = fetch,
  pause: Pause = billingPause,
): Promise<Bill | undefined> {
  const lookup = generationLookup(BASE, key, fetcher, pause);
  const direct = await lookupGenerations(ids, lookup);
  if (!direct?.length) return undefined;
  if (direct.some((row) => row.router != null)) {
    if (!managementKey) return undefined;
    return discover(direct, managementKey, lookup, fetcher, pause);
  }
  if (
    direct.some(
      (row) =>
        generationCharge(row) === 0 &&
        row.native_tokens_prompt === 0 &&
        row.native_tokens_completion === 0 &&
        ((usage.get(row.id)?.prompt ?? 0) > 0 || (usage.get(row.id)?.completion ?? 0) > 0),
    )
  )
    return undefined;
  return total(direct);
}
