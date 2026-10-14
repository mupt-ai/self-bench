import { record, TRUNCATED_OUTPUT } from "../output.js";
import type { EvaluationRun, EvaluationTrial } from "../types.js";

export const DARI_REQUEST_IDS = "solver/dari-request-ids.json";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

type Manifest = { model: "dari/routing"; requestIds: string[] };

/** Only whole streams prove completeness. Historical truncated logs remain unpriced. */
export function dariRequestManifest(files: Map<string, string>): Manifest | undefined {
  const saved = files.get(DARI_REQUEST_IDS);
  if (saved) {
    try {
      const manifest = record(JSON.parse(saved));
      return manifest.model === "dari/routing" && validIds(manifest.requestIds)
        ? { model: "dari/routing", requestIds: manifest.requestIds }
        : undefined;
    } catch {
      return undefined;
    }
  }
  const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
  if (!text || text.startsWith(TRUNCATED_OUTPUT)) return undefined;
  const ids: string[] = [];
  let started = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      if (!started) continue;
      return undefined;
    }
    started = true;
    if (event.type !== "message_end") continue;
    const message = record(event.message);
    if (message.role !== "assistant") continue;
    if (
      message.model !== "dari/routing" ||
      !["harbor-endpoint", "openai"].includes(String(message.provider))
    )
      return undefined;
    const id =
      typeof message.responseId === "string" && message.responseId.startsWith("chatcmpl-")
        ? message.responseId.slice("chatcmpl-".length)
        : "";
    if (!UUID.test(id)) return undefined;
    ids.push(id);
  }
  return validIds(ids) ? { model: "dari/routing", requestIds: ids } : undefined;
}

function validIds(ids: unknown): ids is string[] {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 100_000 &&
    ids.every((id) => typeof id === "string" && UUID.test(id)) &&
    new Set(ids).size === ids.length
  );
}

export function isDariRun(run: EvaluationRun): boolean {
  return run.credentials?.provider === "custom" && run.modelName === "openai/dari/routing";
}

/** Exact authenticated records, not a blended rate or a subscription cash charge. */
export async function dariTrialCost(
  run: EvaluationRun,
  trial: EvaluationTrial,
  env: NodeJS.ProcessEnv,
  files: Map<string, string>,
  fetcher: typeof fetch = fetch,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 5000)),
): Promise<Pick<EvaluationTrial, "apiCostUsd" | "costSource" | "modelVerified">> {
  if (!isDariRun(run) || trial.harness !== "pi" || !env.OPENAI_API_KEY) return {};
  let origin: string;
  try {
    const endpoint = new URL(env.OPENAI_BASE_URL ?? "");
    // Never send a custom credential to a different host or follow a redirect with it.
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "routing.dari.dev" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password
    )
      return {};
    origin = endpoint.origin;
  } catch {
    return {};
  }
  const manifest = dariRequestManifest(files);
  if (!manifest) return {};
  const pricedRequests = new Map<string, number>();
  try {
    for (let index = 0; index < manifest.requestIds.length; index += 1000) {
      const ids = manifest.requestIds.slice(index, index + 1000);
      let costs: Map<string, number> | undefined;
      for (let attempt = 0; attempt < 7; attempt++) {
        const response = await fetcher(`${origin}/v1/request-costs`, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ request_ids: ids }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return {};
        const body = record(await response.json());
        if (typeof body.complete !== "boolean" || !Array.isArray(body.data)) return {};
        if (!body.complete) {
          if (attempt < 6) await pause();
          continue;
        }
        const rows = body.data.map(record);
        const byId = new Map(rows.map((row) => [row.request_id, row]));
        if (
          byId.size !== rows.length ||
          rows.some(
            (row) =>
              typeof row.request_id !== "string" ||
              !UUID.test(row.request_id) ||
              !ids.includes(row.request_id),
          )
        )
          return {};
        if (body.complete !== (rows.length === ids.length)) return {};
        if (ids.some((id) => !byId.has(id))) {
          if (attempt < 6) await pause();
          continue;
        }
        if (rows.some((row) => typeof row.selected_model !== "string" || !row.selected_model))
          return {};
        const prices = new Map<string, number>();
        let validPrices = true;
        for (const row of rows) {
          if (
            typeof row.model_cost_usd !== "string" ||
            !/^\d+(?:\.\d+)?$/.test(row.model_cost_usd) ||
            !Number.isFinite(Number(row.model_cost_usd))
          ) {
            validPrices = false;
            break;
          }
          prices.set(row.request_id as string, Number(row.model_cost_usd));
        }
        if (validPrices) {
          costs = prices;
          break;
        }
        // Ingest is asynchronous. Incomplete data is never a zero or partial trial cost.
        if (attempt < 6) await pause();
      }
      if (!costs) return {};
      for (const [id, cost] of costs) {
        const existing = pricedRequests.get(id);
        if (existing !== undefined && existing !== cost) return {};
        pricedRequests.set(id, cost);
      }
    }
  } catch {
    return {};
  }
  const total = [...pricedRequests.values()].reduce((sum, cost) => sum + cost, 0);
  return pricedRequests.size > 0 && Number.isFinite(total)
    ? { modelVerified: true, apiCostUsd: total, costSource: "router-reference-rates" }
    : {};
}
