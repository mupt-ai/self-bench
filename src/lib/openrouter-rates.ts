import { models, type Rates, setOpenRouterRates } from "../contracts/models.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const REFRESH_MS = 60 * 60 * 1000;

/**
 * Loads OpenRouter's list prices for the catalog's models. A model OpenRouter does not price
 * keeps the catalog's reference rates; OpenRouter omits cache prices for providers that do not
 * charge separately for caching, and those fall back to the input price.
 */
export async function refreshOpenRouterRates(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(MODELS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenRouter models returned ${response.status}`);
  const body = (await response.json()) as { data?: { id?: unknown; pricing?: unknown }[] };
  const wanted = new Set(models.map((model) => model.openRouter));
  const asOf = new Date().toISOString().slice(0, 10);
  const rates = new Map<string, { rates: Rates; asOf: string }>();
  for (const entry of body.data ?? []) {
    if (typeof entry.id !== "string" || !wanted.has(entry.id)) continue;
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    if (input === undefined || output === undefined) continue;
    const cacheRead = perMillion(pricing.input_cache_read) ?? input;
    const cacheWrite = perMillion(pricing.input_cache_write) ?? input;
    rates.set(entry.id, { rates: [input, output, cacheRead, cacheWrite], asOf });
  }
  if (!rates.size) throw new Error("OpenRouter returned no prices for catalog models");
  setOpenRouterRates(rates);
}

/** Loads live rates now and hourly; failures are logged and the last good rates stay in use. */
export function keepOpenRouterRatesFresh(): { ready: Promise<void>; stop(): void } {
  const refresh = () =>
    refreshOpenRouterRates().catch((error: unknown) =>
      console.warn("OpenRouter pricing refresh failed; keeping current rates", error),
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
