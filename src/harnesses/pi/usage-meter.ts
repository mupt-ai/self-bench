import type { ModelUsage } from "../../sandbox/contracts.js";

/**
 * Accumulates Pi's per-message token usage from its JSON event stream: sandbox stdout is a
 * stream of JSON events, where each assistant `message_end` carries the message's usage.
 */
export class PiUsageMeter {
  private decoder = new TextDecoder();
  private buffer = "";
  private dropping = false;
  private totals: { input: number; output: number; cacheRead: number; cacheWrite: number } = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  private messages = 0;

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.dropping && line.length <= 1048576) this.accept(line);
      this.dropping = false;
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 1048576) {
      this.buffer = "";
      this.dropping = true;
    }
  }

  private accept(line: string) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Non-event command output.
    }
    if (typeof event !== "object" || event === null) return;
    const record = event as { type?: unknown; message?: unknown };
    if (record.type !== "message_end" || typeof record.message !== "object") return;
    const message = record.message as { role?: unknown; usage?: unknown };
    if (message.role !== "assistant" || typeof message.usage !== "object" || message.usage === null)
      return;
    const counts = message.usage as Record<string, unknown>;
    const token = (key: string) => (typeof counts[key] === "number" ? counts[key] : 0);
    this.totals = {
      input: this.totals.input + token("input"),
      output: this.totals.output + token("output"),
      cacheRead: this.totals.cacheRead + token("cacheRead"),
      cacheWrite: this.totals.cacheWrite + token("cacheWrite"),
    };
    this.messages += 1;
  }

  /** Total token consumption across every assistant message observed so far. */
  usage(): ModelUsage {
    return { ...this.totals, messages: this.messages };
  }
}
