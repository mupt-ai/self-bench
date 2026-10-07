import { modelIdPattern, type Rates, type ThinkingLevel } from "../contracts/models.js";
import {
  type Gateway,
  type ListedModel,
  type ListedRates,
  listRates,
  listTiers,
  type PiModel,
  readsAndWritesText,
  reasoningLevels,
} from "./gateway.js";

interface VercelEntry {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  tags?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  context_window?: unknown;
  max_tokens?: unknown;
  pricing?: unknown;
  reasoning_options?: unknown;
  deprecated_at?: unknown;
  released?: unknown;
}

/**
 * Vercel AI Gateway. Harbor's Pi adapter reads its key from a variable Pi does not, so Pi runs
 * through SelfBench's adapter (harnesses/harbor/runtime/harbor_gateway.py).
 */
export const vercelAiGateway: Gateway = {
  label: "Vercel AI Gateway",
  keyVariable: "AI_GATEWAY_API_KEY",
  openAiBase: "https://ai-gateway.vercel.sh/v1",
  anthropicBase: "https://ai-gateway.vercel.sh",
  hosts: ["ai-gateway.vercel.sh"],
  harborPi: "harbor_gateway:GatewayPi",
  vendorAliases: {
    alibaba: "qwen",
    bytedance: "bytedance-seed",
    meta: "meta-llama",
    mistral: "mistralai",
    spacexai: "x-ai",
    zai: "z-ai",
  },
  modelsUrl: "https://ai-gateway.vercel.sh/v1/models",
  // Model pages drop the vendor: /ai-gateway/models/glm-5.3.
  modelPage: (id) => `https://vercel.com/ai-gateway/models/${id.slice(id.indexOf("/") + 1)}`,
  parse,
};

/** Its list prices and its models, newest first: it reports no benchmark or popularity. */
function parse(body: unknown, asOf: string) {
  const rates = new Map<string, ListedRates>();
  const listed: (ListedModel & { released: number })[] = [];
  for (const entry of (body as { data?: VercelEntry[] }).data ?? []) {
    if (typeof entry.id !== "string") continue;
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const entryRates = listRates(
      pricing.input,
      pricing.output,
      pricing.input_cache_read,
      pricing.input_cache_write,
    );
    if (!entryRates) continue;
    rates.set(entry.id, { rates: entryRates, asOf, ...sizeTiers(pricing) });
    if (drivesAgents(entry.id, entry)) {
      const thinking = efforts(entry.reasoning_options);
      const label =
        typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id;
      listed.push({
        id: entry.id,
        label,
        ...(thinking.length ? { thinking } : {}),
        pi: piModel(entry.id, label, entry, thinking, entryRates),
        released: typeof entry.released === "number" ? entry.released : -1,
      });
    }
  }
  listed.sort((left, right) => right.released - left.released);
  return { rates, models: listed.map(({ released: _released, ...model }) => model) };
}

/**
 * Tiered models price prompts by size, each price in its own list of tiers whose first is the
 * listed rate. A long-context tier begins wherever one list's does; a list that has not begun yet
 * still charges its listed rate, and a price without a list is unknown past the first tier.
 */
function sizeTiers(pricing: Record<string, unknown>) {
  const lists = [
    pricing.input_tiers,
    pricing.output_tiers,
    pricing.input_cache_read_tiers,
    pricing.input_cache_write_tiers,
  ].map((list) => (Array.isArray(list) ? list : undefined));
  const listed = [
    pricing.input,
    pricing.output,
    pricing.input_cache_read,
    pricing.input_cache_write,
  ];
  const starts = new Set(lists.flatMap((list) => list?.map((tier) => tier?.min) ?? []));
  const price = (index: number, from: number) => {
    const list = lists[index];
    if (!list) return undefined;
    const tier = list.find(
      (candidate) =>
        typeof candidate?.min === "number" &&
        candidate.min <= from &&
        (typeof candidate.max !== "number" || from < candidate.max),
    );
    const begins = list.every(
      (candidate) => typeof candidate?.min === "number" && candidate.min > from,
    );
    return tier ? tier.cost : begins ? listed[index] : undefined;
  };
  return listTiers(
    { cacheRead: pricing.input_cache_read, cacheWrite: pricing.input_cache_write },
    [...starts].filter(positive).map((from) => ({
      from,
      input: price(0, from),
      output: price(1, from),
      cacheRead: price(2, from),
      cacheWrite: price(3, from),
    })),
  );
}

/** A language model that calls tools and reads and writes text, not scheduled for removal. */
function drivesAgents(id: string, entry: VercelEntry): boolean {
  return (
    modelIdPattern.test(id) &&
    entry.type === "language" &&
    !entry.deprecated_at &&
    Array.isArray(entry.tags) &&
    entry.tags.includes("tool-use") &&
    readsAndWritesText(entry.modalities?.input, entry.modalities?.output)
  );
}

/** Reasoning options list the efforts a model accepts; a bare on/off toggle offers no level. */
function efforts(options: unknown) {
  const effort = Array.isArray(options)
    ? options.find((option) => option?.type === "effort" && Array.isArray(option.values))
    : undefined;
  return effort ? reasoningLevels(effort.values) : [];
}

/**
 * Pi reaches the gateway over Anthropic Messages. Pi asks a model its catalog lacks for a thinking
 * budget, which the gateway cannot pass to some vendors (Mistral: "invalid mistral provider
 * options"), while every model that lists efforts takes adaptive thinking with an effort.
 */
function piModel(
  id: string,
  name: string,
  entry: VercelEntry,
  thinking: readonly ThinkingLevel[],
  [input, output, cacheRead, cacheWrite]: Rates,
): PiModel {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const inputs = entry.modalities?.input;
  // Anthropic Messages has no minimal effort, so Pi keeps its own mapping (to low) for it.
  const efforts = thinking.filter((level) => level !== "off" && level !== "minimal");
  return {
    id,
    name,
    reasoning: tags.includes("reasoning") || efforts.length > 0,
    input: Array.isArray(inputs) && inputs.includes("image") ? ["text", "image"] : ["text"],
    ...(positive(entry.context_window) ? { contextWindow: entry.context_window } : {}),
    ...(positive(entry.max_tokens) ? { maxTokens: entry.max_tokens } : {}),
    cost: { input, output, cacheRead, cacheWrite },
    ...(efforts.length
      ? { thinkingLevelMap: Object.fromEntries(efforts.map((level) => [level, level])) }
      : {}),
    // The gateway returns other vendors' reasoning without Anthropic's signatures, and takes it
    // back so; Pi would otherwise replay it as text.
    compat: {
      allowEmptySignature: true,
      ...(efforts.length ? { forceAdaptiveThinking: true } : {}),
    },
  };
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
