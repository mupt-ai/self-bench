import type { SelfBenchWorkerConfig } from "../../../config.js";

export type E2BExecutionConfig = Extract<
  SelfBenchWorkerConfig["execution"],
  { readonly kind: "e2b" }
>;

export interface E2BLifecycleTimings {
  readonly cleanupCallTimeoutMs: number;
  readonly cleanupRecoveryDelaysMs: readonly number[];
  readonly cleanupTimeoutMs: number;
  readonly commandKillGraceMs: number;
  readonly diagnosticTimeoutMs: number;
}

export type E2BSleep = (delayMs: number, signal: AbortSignal) => Promise<void>;
