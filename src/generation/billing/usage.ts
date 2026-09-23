import { AsyncLocalStorage } from "node:async_hooks";

/** Model token consumption, matching Pi's per-message usage records. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Usage one sandbox stage consumed, as recorded by the metered sandbox executor. */
export interface StageUsage {
  readonly stage: string;
  /** True when either component uses SelfBench's provider account. */
  readonly managed: boolean;
  readonly managedModel: boolean;
  readonly managedSandbox: boolean;
  /** Pi's provider/model for agent stages; absent for pure compute stages. */
  readonly provider?: string;
  readonly model?: string;
  readonly tokens?: TokenUsage;
  readonly sandboxSeconds: number;
  readonly cpu?: number;
  readonly memoryMiB?: number;
  readonly sandboxCostUsd?: number;
  readonly modelCostUsd?: number;
}

/** A stage usage bound to its run: one database row. */
export type UsageRow = StageUsage & { readonly runId: string; readonly orgId: number };

export interface RunUsageSummary {
  /** Stages already written to the ledger. Their heartbeats must not be added again. */
  readonly settledStages: readonly string[];
  /** Undefined when no model price was available. */
  readonly modelCostUsd: number | undefined;
  /** Undefined when the sandbox provider has no published compute price. */
  readonly sandboxCostUsd: number | undefined;
  readonly managedCostUsd: number;
  /** Total input, output, and cache tokens consumed by model stages. */
  readonly modelTokens: TokenUsage;
  readonly tokens: number;
  readonly sandboxSeconds: number;
}

const usage = new AsyncLocalStorage<{ record: (entry: StageUsage) => Promise<void> }>();

/** Runs an action whose sandbox compute and Pi token usage is recorded into the ledger. */
export function withUsageLedger<T>(
  record: (entry: StageUsage) => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  return usage.run({ record }, action);
}

/** Records stage usage; a no-op outside metered runs or when the ledger write fails. */
export async function recordStageUsage(entry: StageUsage): Promise<void> {
  const store = usage.getStore();
  if (!store) return;
  try {
    await store.record(entry);
  } catch (error) {
    console.error("Failed to record managed usage", error);
  }
}

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
  usage(): TokenUsage & { readonly messages: number } {
    return { ...this.totals, messages: this.messages };
  }
}
