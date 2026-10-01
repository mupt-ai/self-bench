import { modelIdPattern, type Rates } from "../contracts/models.js";
import {
  type Gateway,
  type ListedModel,
  listRates,
  readsAndWritesText,
  reasoningLevels,
} from "./gateway.js";

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

/** OpenRouter: the catalog names models as OpenRouter does. Harbor knows its key variable. */
export const openRouter: Gateway = {
  label: "OpenRouter",
  keyVariable: "OPENROUTER_API_KEY",
  openAiBase: "https://openrouter.ai/api/v1",
  anthropicBase: "https://openrouter.ai/api",
  hosts: ["openrouter.ai", "*.openrouter.ai"],
  harborPi: "pi",
  modelsUrl: "https://openrouter.ai/api/v1/models?sort=most-popular",
  modelPage: (id) => `https://openrouter.ai/${id}`,
  parse,
};

/**
 * OpenRouter's list prices and its models, frontier first: by the Artificial Analysis
 * intelligence index OpenRouter reports, then the unscored ones by popularity.
 */
function parse(body: unknown, asOf: string) {
  const rates = new Map<string, { rates: Rates; asOf: string }>();
  const listed: (ListedModel & { intelligence: number })[] = [];
  for (const entry of (body as { data?: OpenRouterEntry[] }).data ?? []) {
    if (typeof entry.id !== "string") continue;
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const entryRates = listRates(
      pricing.prompt,
      pricing.completion,
      pricing.input_cache_read,
      pricing.input_cache_write,
    );
    if (!entryRates) continue;
    rates.set(entry.id, { rates: entryRates, asOf });
    if (drivesAgents(entry.id, entry)) {
      const thinking = efforts(entry.reasoning);
      const index = entry.benchmarks?.artificial_analysis?.intelligence_index;
      listed.push({
        id: entry.id,
        label: modelName(entry.name) ?? entry.id,
        ...(thinking.length ? { thinking } : {}),
        intelligence: typeof index === "number" && Number.isFinite(index) ? index : -1,
      });
    }
  }
  // The sort is stable, so equal and unscored models keep OpenRouter's popularity order.
  listed.sort((left, right) => right.intelligence - left.intelligence);
  return { rates, models: listed.map(({ intelligence: _intelligence, ...model }) => model) };
}

/** OpenRouter's name without its vendor prefix: "Kimi K3", not "MoonshotAI: Kimi K3". */
function modelName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  return name.replace(/^[^:]+:\s*/, "").trim() || undefined;
}

/**
 * A model must call tools and read and write text. Variants (`:free`, `:batch`, ...),
 * OpenRouter's own routers and models it has scheduled for removal are left out.
 */
function drivesAgents(id: string, entry: OpenRouterEntry): boolean {
  return (
    modelIdPattern.test(id) &&
    !id.includes(":") &&
    !id.startsWith("openrouter/") &&
    !entry.expiration_date &&
    Array.isArray(entry.supported_parameters) &&
    entry.supported_parameters.includes("tools") &&
    readsAndWritesText(entry.architecture?.input_modalities, entry.architecture?.output_modalities)
  );
}

/** A reasoning model lists its efforts, or leaves them null when it accepts every effort. */
function efforts(reasoning: OpenRouterEntry["reasoning"]) {
  if (!reasoning) return [];
  const supported = reasoning.supported_efforts;
  return reasoningLevels(supported === null ? "any" : Array.isArray(supported) ? supported : []);
}
