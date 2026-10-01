import { modelIdPattern, type Rates } from "../contracts/models.js";
import {
  type Gateway,
  type ListedModel,
  listRates,
  readsAndWritesText,
  reasoningLevels,
} from "./gateway.js";

interface VercelEntry {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  tags?: unknown;
  modalities?: { input?: unknown; output?: unknown };
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
  const rates = new Map<string, { rates: Rates; asOf: string }>();
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
    rates.set(entry.id, { rates: entryRates, asOf });
    if (drivesAgents(entry.id, entry)) {
      const thinking = efforts(entry.reasoning_options);
      listed.push({
        id: entry.id,
        label: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id,
        ...(thinking.length ? { thinking } : {}),
        released: typeof entry.released === "number" ? entry.released : -1,
      });
    }
  }
  listed.sort((left, right) => right.released - left.released);
  return { rates, models: listed.map(({ released: _released, ...model }) => model) };
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
