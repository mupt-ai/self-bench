import { gateways } from "../gateways/index.js";
import { gatewayUsage, readGatewayManifest } from "./gateway-usage.js";
import { generationCharge, jevCost, OPENROUTER_BILLING } from "./jev-cost.js";
import { record, TRUNCATED_OUTPUT } from "./output.js";
import type { EvaluationRun, EvaluationTrial, Harness } from "./types.js";

type BilledGateway = "openrouter" | "vercel-ai-gateway";
export const OPENROUTER_GENERATIONS = "solver/openrouter-generation-ids.json";

/** Preserve accounting IDs before the archived transcript is shortened. */
export function gatewayManifest(
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

/**
 * What the gateway charged for the trial, when every request's bill is available. Jev uses the
 * reconciled full gateway + nested BYOK total as authoritative; other gateways retain it as
 * supporting billing evidence while list pricing remains primary.
 */
export async function billedTrialCost(
  run: EvaluationRun,
  trial: EvaluationTrial,
  env: NodeJS.ProcessEnv,
  files: Map<string, string>,
  billingKey?: string,
): Promise<Pick<EvaluationTrial, "billedCostUsd" | "apiCostUsd" | "costSource">> {
  const provider = run.credentials?.provider;
  if (!trial.modelVerified || (provider !== "openrouter" && provider !== "vercel-ai-gateway"))
    return {};
  const isJev = provider === "openrouter" && run.modelName === "openrouter/typesafe/jev-router";
  if (
    isJev &&
    (!billingKey ||
      (!files.has(OPENROUTER_GENERATIONS) &&
        [...files].some(
          ([name, text]) => name.endsWith("/pi.txt") && text.startsWith(TRUNCATED_OUTPUT),
        )))
  )
    return {};
  if (isJev) files.delete(OPENROUTER_BILLING);
  const cost = await gatewayCost(
    provider,
    env[gateways[provider].keyVariable],
    trial.harness,
    files,
    fetch,
    billingKey,
  );
  if (cost === undefined || (isJev && !files.has(OPENROUTER_BILLING))) return {};
  return trial.apiCostUsd === undefined
    ? { billedCostUsd: cost, apiCostUsd: cost, costSource: "gateway" }
    : { billedCostUsd: cost };
}

/** Only completed Pi replies have a generation ID we can match to a gateway bill. */
export function generationIds(harness: Harness, files: Map<string, string>): string[] | undefined {
  if (harness !== "pi") return undefined;
  const manifest = files.get(OPENROUTER_GENERATIONS);
  if (manifest) return readGatewayManifest(manifest)?.generationIds;
  const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
  if (!text) return undefined;
  const ids: string[] = [];
  const seen = new Set<string>();
  const ends: Record<string, unknown>[] = [];
  let started = false;
  let unfinished = false;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      // Pi's notices precede its stream; a stored tail's final agent_end carries all messages of
      // that agent run.
      if (!started) continue;
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        unfinished = true;
        break;
      }
      return undefined;
    }
    started = true;
    if (event.type === "agent_end") ends.push(event);
    if (event.type !== "message_end") continue;
    const message = record(event.message);
    if (message.role !== "assistant") continue;
    const id = message.responseId;
    if (typeof id !== "string" || !/^(gen_[a-zA-Z0-9]+|gen-[a-zA-Z0-9-]+)$/.test(id))
      return undefined;
    if (seen.has(id)) return undefined;
    seen.add(id);
    ids.push(id);
  }
  if (!text.startsWith(TRUNCATED_OUTPUT)) return ids.length && !unfinished ? ids : undefined;
  const [end] = ends;
  if (ends.length !== 1 || !end || end.willRetry || !Array.isArray(end.messages)) return undefined;
  const messages = end.messages.map(record);
  if (messages.find((message) => message.role !== "system")?.role !== "user") return undefined;
  return responseIds(messages);
}

function responseIds(messages: Record<string, unknown>[]): string[] | undefined {
  const ids = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.responseId);
  return ids.length &&
    ids.every(
      (id) => typeof id === "string" && /^(gen_[a-zA-Z0-9]+|gen-[a-zA-Z0-9-]+)$/.test(id),
    ) &&
    new Set(ids).size === ids.length
    ? (ids as string[])
    : undefined;
}

/** Gateway's charged USD; incomplete lookups leave the caller's usage estimate in place. */
export async function gatewayCost(
  provider: BilledGateway,
  key: string | undefined,
  harness: Harness,
  files: Map<string, string>,
  fetcher: typeof fetch = fetch,
  billingKey?: string,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 5000)),
): Promise<number | undefined> {
  files.delete(OPENROUTER_BILLING);
  const ids = generationIds(harness, files);
  if (!key || !ids) return undefined;
  const tokenBearingIds = generationsWithUsage(files);
  const base =
    provider === "openrouter"
      ? "https://openrouter.ai/api/v1/generation?id="
      : "https://ai-gateway.vercel.sh/v1/generation?id=";
  const lookup = async (
    id: string,
  ): Promise<(Record<string, unknown> & { id: string }) | undefined> => {
    try {
      // OpenRouter's generation record can take ~10 seconds to appear, especially for router
      // models. Keep 404 distinct from other failures, but retry long enough for normal indexing.
      for (let attempt = 0; attempt < 7; attempt++) {
        const response = await fetcher(base + encodeURIComponent(id), {
          redirect: "error",
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          // Both gateways leave a BYOK request's provider charge out of total_cost, which then
          // holds only the gateway's own fee, and report it as upstream_inference_cost instead.
          const data = record((await response.json()).data);
          if (data.id !== undefined && data.id !== id) return undefined;
          return { ...data, id };
        }
        if (response.status !== 404) return undefined;
        if (attempt < 6) await pause();
      }
    } catch {
      // A lookup failure is not a zero-cost request.
    }
    return undefined;
  };
  const generations: (Record<string, unknown> & { id: string })[] = [];
  for (let index = 0; index < ids.length; index += 10) {
    const batch = await Promise.all(ids.slice(index, index + 10).map(lookup));
    if (batch.some((row) => !row)) return undefined;
    generations.push(...(batch as (Record<string, unknown> & { id: string })[]));
  }
  if (
    provider === "openrouter" &&
    generations.some((row) => row.router === "typesafe/jev-router")
  ) {
    if (
      !files.has(OPENROUTER_GENERATIONS) &&
      [...files].some(
        ([name, text]) => name.endsWith("/pi.txt") && text.startsWith(TRUNCATED_OUTPUT),
      )
    )
      return undefined;
    const saved = files.get(OPENROUTER_GENERATIONS);
    const usage = saved ? readGatewayManifest(saved)?.usage : gatewayUsage(files);
    if (!usage) return undefined;
    const bill = await jevCost(generations, billingKey, lookup, usage, fetcher, pause);
    if (!bill) return undefined;
    files.set(OPENROUTER_BILLING, JSON.stringify(bill));
    return bill.cost;
  }
  let total = 0;
  for (const data of generations) {
    const cost = generationCharge(data);
    if (
      cost === undefined ||
      (cost === 0 &&
        data.native_tokens_prompt === 0 &&
        data.native_tokens_completion === 0 &&
        tokenBearingIds.has(data.id))
    )
      return undefined;
    total += cost;
  }
  return Number.isFinite(total) ? total : undefined;
}

function generationsWithUsage(files: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
  if (!text) return ids;
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    const messages =
      event.type === "agent_end" && Array.isArray(event.messages)
        ? event.messages.map(record)
        : event.type === "message_end"
          ? [record(event.message)]
          : [];
    for (const message of messages) {
      if (message.role !== "assistant" || typeof message.responseId !== "string") continue;
      const usage = record(message.usage);
      if (
        [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
          (tokens) => typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0,
        )
      )
        ids.add(message.responseId);
    }
  }
  return ids;
}
