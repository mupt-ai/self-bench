import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestSummary } from "@mupt-ai/dari-gateway";
import type { GatewayUsage, SelfBenchGatewayDeps } from "./platform.js";

/**
 * The model a provider's response says served a gateway call. A router behind a custom endpoint
 * (Shift-1) answers each call from one of several models, names that model in its response, and
 * returns no price, so the call is priced at that model's list rates (platform.ts). The gateway
 * library keeps only the model it asked for, and calls the provider with the global fetch, so the
 * response is read on its way through that fetch, within the gateway request it belongs to.
 */
interface Served {
  model?: string;
  /** The price the response reported for the call, when it reports one (`usage.cost`). */
  cost?: number;
  /** Rewrite budgeted thinking as adaptive thinking (adaptiveThinking). */
  readonly adaptiveThinking?: boolean;
}

const current = new AsyncLocalStorage<Served>();
const TAPPED = Symbol("selfbench.servedModelTap");
/** A line longer than this is not read for a model (non-streamed bodies are one line). */
const MAX_LINE = 16 * 1024 * 1024;

/** Runs one gateway request, noting the model its provider's response names. */
export function withServedModel<T>(
  run: () => Promise<T>,
  options: { adaptiveThinking?: boolean } = {},
): Promise<T> {
  tapFetch();
  return current.run({ ...options }, run);
}

/** The model the current gateway request's provider response named, if any. */
function servedModel(): string | undefined {
  return current.getStore()?.model;
}

/** The price the current gateway request's provider response reported, if it reported one. */
function reportedServedCost(): number | undefined {
  return current.getStore()?.cost;
}

/**
 * A custom endpoint's call at the price its response reported (Ramp's usage.cost), else at the
 * list rates of the model its response named (`provider`'s, for an endpoint that is one in Pi's
 * registry), else unpriced.
 */
export function servedCost(
  priceServed: SelfBenchGatewayDeps["servedModelCost"],
  summary: RequestSummary,
  provider: string | undefined,
): Pick<GatewayUsage, "costUsd" | "costSource"> {
  const reported = reportedServedCost();
  if (reported !== undefined) return { costUsd: reported, costSource: "provider" };
  const model = servedModel();
  const tokens = {
    input: summary.input_tokens ?? 0,
    output: summary.output_tokens ?? 0,
    cacheRead: summary.cache_read_tokens ?? 0,
    cacheWrite: summary.cache_write_tokens ?? 0,
  };
  const costUsd = model ? priceServed?.(model, tokens, provider) : undefined;
  return costUsd === undefined
    ? { costUsd: null, costSource: null }
    : { costUsd, costSource: "pricing" };
}

/**
 * Wraps the global fetch once (again if something replaced it since): within a gateway request,
 * each response is passed through unchanged while its model is read.
 */
function tapFetch(): void {
  const inner = globalThis.fetch as typeof fetch & { [TAPPED]?: true };
  if (inner[TAPPED]) return;
  const tapped = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const store = current.getStore();
      const body = store?.adaptiveThinking ? adaptiveThinking(init?.body) : undefined;
      const response = await inner(input, body === undefined ? init : { ...init, body });
      const served = current.getStore();
      if (!served || !response.body) return response;
      return new Response(response.body.pipeThrough(modelReader(served)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    { [TAPPED]: true as const },
  );
  globalThis.fetch = Object.assign(tapped, inner) as unknown as typeof fetch;
}

/** Passes bytes through, recording the model each JSON line or SSE `data:` frame names. */
function modelReader(served: Served): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  const read = (line: string) => {
    const text = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!text.startsWith("{") || !(text.includes('"model"') || text.includes('"cost"'))) return;
    try {
      const frame = JSON.parse(text);
      const model = namedModel(frame);
      if (model) served.model = model;
      const cost = reportedCost(frame);
      if (cost !== undefined) served.cost = cost;
    } catch {
      // Not a JSON frame: nothing to read.
    }
  };
  const consume = (text: string, end: boolean) => {
    pending += text;
    const lines = pending.split("\n");
    pending = end ? "" : (lines.pop() ?? "");
    for (const line of lines) read(line);
    if (pending.length > MAX_LINE) pending = "";
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      consume(decoder.decode(chunk, { stream: true }), false);
    },
    flush() {
      consume(decoder.decode(), true);
    },
  });
}

/**
 * The model a response or stream frame names: at its top (Chat Completions, a whole Messages
 * reply), or in the response (Responses events) or message (Messages `message_start`) it carries.
 */
function namedModel(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const { model, response, message } = frame as Record<string, unknown>;
  for (const candidate of [model, field(response), field(message)])
    if (typeof candidate === "string" && candidate) return candidate;
  return undefined;
}

function field(value: unknown, name: string = "model"): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}

/** The thinking effort Pi's budget for each level stands for (its DEFAULT_THINKING_BUDGETS). */
const BUDGET_EFFORTS = [
  [2048, "low"],
  [8192, "medium"],
] as const;

/**
 * A Messages call's budgeted thinking (`{type: "enabled", budget_tokens}`), the form Pi sends a
 * model it has no metadata for, as the adaptive thinking current Claude models require instead
 * (`thinking.type.enabled is not supported for this model`), at the effort the budget stood for.
 * Undefined when the call is not one: it is sent unchanged.
 */
function adaptiveThinking(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string" || !body.includes('"budget_tokens"')) return undefined;
  try {
    const payload = JSON.parse(body);
    const thinking = payload?.thinking;
    if (thinking?.type !== "enabled" || typeof thinking.budget_tokens !== "number")
      return undefined;
    const budget = thinking.budget_tokens;
    const effort = BUDGET_EFFORTS.find(([limit]) => budget <= limit)?.[1] ?? "high";
    const { budget_tokens: _budget, type: _type, ...display } = thinking;
    return JSON.stringify({
      ...payload,
      thinking: { ...display, type: "adaptive" },
      output_config: { ...payload.output_config, effort },
    });
  } catch {
    return undefined;
  }
}

/**
 * The price a frame reports for its call: `usage.cost` at the top of a Chat Completions chunk, or
 * in a Responses event's response, or a Messages message. Undefined when none is reported.
 */
function reportedCost(frame: unknown): number | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const { usage, response, message } = frame as Record<string, unknown>;
  for (const candidate of [usage, field(response, "usage"), field(message, "usage")]) {
    const cost =
      candidate && typeof candidate === "object"
        ? (candidate as { cost?: unknown }).cost
        : undefined;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return cost;
  }
  return undefined;
}
