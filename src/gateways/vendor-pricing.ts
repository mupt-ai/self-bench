import type { ModelPricing, Rates } from "../contracts/models.js";
import { listRates } from "./gateway.js";

/** OpenRouter's provider slug for a vendor that serves its own models under another name. */
const VENDOR_PROVIDERS: Readonly<Record<string, string>> = {
  "bytedance-seed": "seed",
  google: "google-ai-studio",
  "meta-llama": "meta",
  mistralai: "mistral",
  qwen: "alibaba",
  "x-ai": "xai",
};

/**
 * A model's price on its vendor's own API before any discount, for the catalog's model `id`
 * (OpenRouter's spelling, "mistralai/mistral-large-4-0"). Gateway runs are priced at it, so a cost
 * reads the same whichever provider a gateway routed to, and a launch promotion does not
 * understate it. Neither gateway's models list reports discounts; OpenRouter's endpoints for a
 * model do, each with its current price and the share taken off it. Undefined when OpenRouter does
 * not list the vendor serving the model, or does not answer.
 */
export async function vendorListRates(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<{ rates: Rates; source: string } | undefined> {
  const vendor = id.slice(0, Math.max(0, id.indexOf("/")));
  if (!vendor) return undefined;
  const provider = VENDOR_PROVIDERS[vendor] ?? vendor;
  try {
    const response = await fetcher(`https://openrouter.ai/api/v1/models/${id}/endpoints`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { data?: { endpoints?: unknown } };
    const endpoints = Array.isArray(body.data?.endpoints) ? body.data.endpoints : [];
    // Tags name the provider, then any variant of its endpoint: "moonshotai/mxfp4", "openai/flex".
    const own = endpoints.filter(
      (endpoint) => typeof endpoint?.tag === "string" && endpoint.tag.split("/")[0] === provider,
    );
    const endpoint = own.find((candidate) => candidate.tag === provider) ?? own[0];
    const pricing = (endpoint?.pricing ?? {}) as Record<string, unknown>;
    const rates = listRates(
      pricing.prompt,
      pricing.completion,
      pricing.input_cache_read,
      pricing.input_cache_write,
    );
    if (!rates) return undefined;
    const discount =
      typeof pricing.discount === "number" && pricing.discount > 0 && pricing.discount < 1
        ? pricing.discount
        : 0;
    const full = (rate: number) => Number((rate / (1 - discount)).toFixed(6));
    const [input, output, cacheRead, cacheWrite] = rates;
    return {
      rates: [full(input), full(output), full(cacheRead), full(cacheWrite)],
      source: `https://openrouter.ai/${id}/providers`,
    };
  } catch {
    return undefined;
  }
}

/** `pricing` at the vendor's list rates, keeping its long-context bound. */
export function atVendorRates(
  pricing: ModelPricing,
  { rates: [input, output, cacheRead, cacheWrite], source }: { rates: Rates; source: string },
  asOf: string,
): ModelPricing {
  return { ...pricing, input, output, cacheRead, cacheWrite, source, asOf };
}
