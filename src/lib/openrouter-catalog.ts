import {
  type ListedModel,
  type Rates,
  setOpenRouterModels,
  setOpenRouterRates,
  type ThinkingLevel,
  thinkingLevels,
} from "../contracts/models.js";
import { modelIdPattern } from "../evaluation/models.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models?sort=most-popular";
const REFRESH_MS = 60 * 60 * 1000;

interface OpenRouterEntry {
  id?: unknown;
  name?: unknown;
  pricing?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  supported_parameters?: unknown;
  reasoning?: { supported_efforts?: unknown } | null;
  expiration_date?: unknown;
  benchmarks?: { artificial_analysis?: { intelligence_index?: unknown } | null } | null;
}

/**
 * Loads OpenRouter's list prices and its models, frontier first: by the Artificial Analysis
 * intelligence index OpenRouter reports, then the unscored ones by popularity. A model OpenRouter
 * does not price keeps the catalog's reference rates; OpenRouter omits cache prices for providers
 * that do not charge separately for caching, and those fall back to the input price.
 */
export async function refreshOpenRouterCatalog(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(MODELS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenRouter models returned ${response.status}`);
  const body = (await response.json()) as { data?: OpenRouterEntry[] };
  const asOf = new Date().toISOString().slice(0, 10);
  const rates = new Map<string, { rates: Rates; asOf: string }>();
  const listed: (ListedModel & { intelligence: number })[] = [];
  for (const entry of body.data ?? []) {
    if (typeof entry.id !== "string") continue;
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    if (input === undefined || output === undefined) continue;
    const cacheRead = perMillion(pricing.input_cache_read) ?? input;
    const cacheWrite = perMillion(pricing.input_cache_write) ?? input;
    rates.set(entry.id, { rates: [input, output, cacheRead, cacheWrite], asOf });
    if (drivesAgents(entry.id, entry)) {
      const thinking = reasoningLevels(entry.reasoning);
      const index = entry.benchmarks?.artificial_analysis?.intelligence_index;
      listed.push({
        id: entry.id,
        label: modelName(entry.name) ?? entry.id,
        ...(thinking.length ? { thinking } : {}),
        intelligence: typeof index === "number" && Number.isFinite(index) ? index : -1,
      });
    }
  }
  if (!rates.size) throw new Error("OpenRouter returned no prices");
  setOpenRouterRates(rates);
  // The sort is stable, so equal and unscored models keep OpenRouter's popularity order.
  listed.sort((left, right) => right.intelligence - left.intelligence);
  setOpenRouterModels(listed.map(({ intelligence: _intelligence, ...model }) => model));
}

/** OpenRouter's name without its vendor prefix: "Kimi K3", not "MoonshotAI: Kimi K3". */
function modelName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  return name.replace(/^[^:]+:\s*/, "").trim() || undefined;
}

/**
 * Every harness is an agent loop over text, so a model must call tools and read and write text.
 * Variants (`:free`, `:batch`, ...), OpenRouter's own routers and models it has scheduled for
 * removal are left out.
 */
function drivesAgents(id: string, entry: OpenRouterEntry): boolean {
  const text = (modalities: unknown) => Array.isArray(modalities) && modalities.includes("text");
  return (
    modelIdPattern.test(id) &&
    !id.includes(":") &&
    !id.startsWith("openrouter/") &&
    !entry.expiration_date &&
    Array.isArray(entry.supported_parameters) &&
    entry.supported_parameters.includes("tools") &&
    text(entry.architecture?.input_modalities) &&
    text(entry.architecture?.output_modalities)
  );
}

/**
 * The levels a reasoning model accepts. OpenRouter lists its efforts, or leaves them null when it
 * accepts every effort; it calls reasoning turned off "none", which the catalog calls "off".
 */
function reasoningLevels(reasoning: OpenRouterEntry["reasoning"]): ThinkingLevel[] {
  if (!reasoning) return [];
  const efforts = reasoning.supported_efforts;
  return thinkingLevels.filter(
    (level) =>
      level !== "default" &&
      (efforts === null ||
        (Array.isArray(efforts) && efforts.includes(level === "off" ? "none" : level))),
  );
}

/** Loads the catalog now and hourly; failures are logged and the last good catalog stays in use. */
export function keepOpenRouterCatalogFresh(): { ready: Promise<void>; stop(): void } {
  const refresh = () =>
    refreshOpenRouterCatalog().catch((error: unknown) =>
      console.warn("OpenRouter catalog refresh failed; keeping the current catalog", error),
    );
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
  return { ready: refresh(), stop: () => clearInterval(timer) };
}

/** OpenRouter quotes $ per token as a decimal string; negative means the price varies. */
function perMillion(value: unknown): number | undefined {
  const perToken = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return Number((perToken * 1_000_000).toFixed(6));
}
