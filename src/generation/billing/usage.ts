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
  /** Set for a started sandbox, which is recorded at most once. */
  readonly sandboxId?: string;
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
