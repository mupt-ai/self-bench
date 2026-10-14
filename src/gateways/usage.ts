import { record, TRUNCATED_OUTPUT } from "../evaluation/output.js";
import type { Harness } from "../evaluation/types.js";

type Usage = { prompt: number; completion: number };
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Retain client-reported usage to reject contradictory free billing records. */
export function gatewayUsage(files: Map<string, string>): Map<string, Usage> {
  const usage = new Map<string, Usage>();
  const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
  if (!text) return usage;
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
      const tokens = record(message.usage);
      if (
        ![
          tokens.input ?? 0,
          tokens.output ?? 0,
          tokens.cacheRead ?? 0,
          tokens.cacheWrite ?? 0,
        ].every(count)
      )
        continue;
      const prompt =
        Number(tokens.input ?? 0) + Number(tokens.cacheRead ?? 0) + Number(tokens.cacheWrite ?? 0);
      if (!Number.isSafeInteger(prompt)) continue;
      const measured = { prompt, completion: Number(tokens.output ?? 0) };
      const previous = usage.get(message.responseId);
      usage.set(message.responseId, {
        prompt: Math.max(previous?.prompt ?? 0, measured.prompt),
        completion: Math.max(previous?.completion ?? 0, measured.completion),
      });
    }
  }
  return usage;
}

export function readGatewayManifest(
  text: string,
): { generationIds: string[]; usage: Map<string, Usage> } | undefined {
  try {
    const saved = record(JSON.parse(text));
    const ids = saved.generationIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100000 ||
      !ids.every(
        (id) => typeof id === "string" && /^(gen_[A-Za-z0-9]+|gen-[A-Za-z0-9-]+)$/.test(id),
      ) ||
      new Set(ids).size !== ids.length ||
      !Array.isArray(saved.usage)
    )
      return undefined;
    const rows = saved.usage.map(record);
    if (
      rows.some(
        (row) =>
          typeof row.id !== "string" ||
          !ids.includes(row.id) ||
          !count(row.prompt) ||
          !count(row.completion),
      )
    )
      return undefined;
    const usage = new Map(
      rows.map((row) => [
        String(row.id),
        { prompt: Number(row.prompt), completion: Number(row.completion) },
      ]),
    );
    return usage.size === rows.length ? { generationIds: ids, usage } : undefined;
  } catch {
    return undefined;
  }
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
