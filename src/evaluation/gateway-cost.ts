import { gateways } from "../gateways/index.js";
import { record, TRUNCATED_OUTPUT } from "./output.js";
import type { EvaluationRun, EvaluationTrial, Harness } from "./types.js";

type BilledGateway = "openrouter" | "vercel-ai-gateway";

/** Override the usage estimate only when the whole trial's gateway bill is available. */
export async function billedTrialCost(
  run: EvaluationRun,
  trial: EvaluationTrial,
  env: NodeJS.ProcessEnv,
  files: Map<string, string>,
): Promise<Pick<EvaluationTrial, "apiCostUsd" | "costSource">> {
  const provider = run.credentials?.provider;
  if (!trial.modelVerified || (provider !== "openrouter" && provider !== "vercel-ai-gateway"))
    return {};
  const cost = await gatewayCost(
    provider,
    env[gateways[provider].keyVariable],
    trial.harness,
    files,
  );
  return cost === undefined ? {} : { apiCostUsd: cost, costSource: "gateway" };
}

/** Only completed Pi replies have a generation ID we can match to a gateway bill. */
export function generationIds(harness: Harness, files: Map<string, string>): string[] | undefined {
  if (harness !== "pi") return undefined;
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
      // A stored tail's final agent_end carries all messages of that agent run.
      if (text.startsWith(TRUNCATED_OUTPUT) && !started) continue;
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
): Promise<number | undefined> {
  const ids = generationIds(harness, files);
  if (!key || !ids) return undefined;
  const base =
    provider === "openrouter"
      ? "https://openrouter.ai/api/v1/generation?id="
      : "https://ai-gateway.vercel.sh/v1/generation?id=";
  const lookup = async (id: string): Promise<number | undefined> => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetcher(base + encodeURIComponent(id), {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const cost = record((await response.json()).data).total_cost;
          return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
        }
        if (response.status !== 404) return undefined;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch {
      // A lookup failure is not a zero-cost request.
    }
    return undefined;
  };
  let total = 0;
  for (let index = 0; index < ids.length; index += 10) {
    const costs = await Promise.all(ids.slice(index, index + 10).map(lookup));
    if (costs.some((cost) => cost === undefined)) return undefined;
    total += (costs as number[]).reduce((sum, cost) => sum + cost, 0);
  }
  return total;
}
