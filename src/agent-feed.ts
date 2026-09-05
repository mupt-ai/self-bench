import { redactSecrets } from "./provenance/redact.js";

export interface AgentFeedEvent {
  kind: "message" | "tool" | "result";
  text: string;
  timestamp?: string;
}

/** Public agent output only: never prompts, hidden reasoning, or provider metadata. */
export function agentFeedEvents(jsonl: string, secrets: readonly string[] = []): AgentFeedEvent[] {
  const events: AgentFeedEvent[] = [];
  const secretValues = secrets.flatMap((secret) => {
    try {
      const strings: string[] = [];
      JSON.parse(secret, (_key, value) => {
        if (typeof value === "string") strings.push(value);
        return value;
      });
      return strings;
    } catch {
      return [secret];
    }
  });
  const clean = (text: string) => {
    let value = text;
    for (const secret of secretValues)
      if (secret.length >= 8) value = value.split(secret).join("[REDACTED]");
    return redactSecrets(value).slice(0, 8000);
  };
  for (const line of jsonl.split("\n")) {
    try {
      const entry = JSON.parse(line);
      const message = entry.message;
      if (!message || !["assistant", "toolResult"].includes(message.role)) continue;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          events.push({
            kind: message.role === "toolResult" ? "result" : "message",
            text: clean(block.text),
            ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
          });
        } else if (message.role === "assistant" && block.type === "toolCall") {
          events.push({
            kind: "tool",
            text: clean(`${block.name}\n${JSON.stringify(block.arguments ?? {}, null, 2)}`),
            ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
          });
        }
      }
    } catch {
      // A bounded tail can start/end in the middle of a JSONL entry.
    }
  }
  return events.slice(-60);
}
