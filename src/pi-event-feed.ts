import { type AgentFeedEvent, agentFeedEvents } from "./agent-feed.js";

interface PiEvent {
  type: string;
  timestamp?: string;
  message?: { role: string; content?: { type: string; text: string }[] };
  assistantMessageEvent?: { type: string; delta: string; contentIndex?: number };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: { content?: { type: string; text: string }[] };
  result?: { content?: { type: string; text: string }[] };
}

/** Incremental JSONL framing with bounded state and no hidden reasoning in public output. */
export class PiEventFeed {
  private decoder = new TextDecoder();
  private buffer = "";
  private dropping = false;
  private rows: { id: string; event: AgentFeedEvent }[] = [];
  private turn = 0;
  constructor(private readonly secrets: readonly string[] = []) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.dropping && line.length <= 1048576) {
        try {
          this.accept(JSON.parse(line));
        } catch {
          /* Ignore non-event command output. */
        }
      }
      this.dropping = false;
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 1048576) {
      this.buffer = "";
      this.dropping = true;
    }
  }

  events(): AgentFeedEvent[] {
    // Sanitize at the snapshot boundary, after fragmented deltas have been assembled.
    return this.rows.map(({ event }) => ({
      ...event,
      text:
        agentFeedEvents(
          JSON.stringify({
            message: { role: "assistant", content: [{ type: "text", text: event.text }] },
          }),
          this.secrets,
        )[0]?.text ?? "",
    }));
  }

  private put(
    id: string,
    kind: AgentFeedEvent["kind"],
    text: string,
    append = false,
    timestamp?: string,
  ) {
    const existing = this.rows.find((row) => row.id === id);
    if (existing) {
      existing.event.text = (append ? existing.event.text + text : text).slice(-8000);
      if (timestamp) existing.event.timestamp = timestamp;
    } else
      this.rows.push({
        id,
        event: { kind, text: text.slice(-8000), ...(timestamp ? { timestamp } : {}) },
      });
    this.rows = this.rows.slice(-60);
  }

  private accept(event: PiEvent) {
    if (event.type === "message_start" && event.message?.role === "assistant") this.turn += 1;
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") {
        this.put(
          `message-${this.turn}-${delta.contentIndex ?? 0}`,
          "message",
          delta.delta,
          true,
          event.timestamp,
        );
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const [index, block] of (event.message.content ?? []).entries()) {
        if (block.type === "text")
          this.put(`message-${this.turn}-${index}`, "message", block.text, false, event.timestamp);
      }
    }
    if (event.type === "tool_execution_start") {
      this.put(
        `tool-${event.toolCallId}`,
        "tool",
        `${event.toolName}\n${JSON.stringify(event.args ?? {}, null, 2)}`,
      );
    }
    if (["tool_execution_update", "tool_execution_end"].includes(event.type)) {
      const result = event.partialResult ?? event.result;
      const text = (result?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      this.put(`result-${event.toolCallId}`, "result", text, false, event.timestamp);
    }
  }
}
