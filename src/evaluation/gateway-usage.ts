import { record } from "./output.js";

type Usage = { prompt: number; completion: number };
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Pi's worker usage proves both worker calls of an advisor turn; advisor usage is extra. */
export function gatewayUsage(files: Map<string, string>): Map<string, Usage> {
  const usage = new Map<string, Usage>();
  const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
  if (!text) return usage;
  const conflicts = new Set<string>();
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
      if (![tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].every(count))
        continue;
      const prompt = Number(tokens.input) + Number(tokens.cacheRead) + Number(tokens.cacheWrite);
      if (!Number.isSafeInteger(prompt)) continue;
      const measured = { prompt, completion: Number(tokens.output) };
      const previous = usage.get(message.responseId);
      if (
        previous &&
        (previous.prompt !== measured.prompt || previous.completion !== measured.completion)
      )
        conflicts.add(message.responseId);
      usage.set(message.responseId, measured);
    }
  }
  for (const id of conflicts) usage.delete(id);
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
      !ids.every((id) => typeof id === "string" && /^gen-[A-Za-z0-9-]+$/.test(id)) ||
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
