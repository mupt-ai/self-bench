import type { ReactNode } from "react";
import { dollars } from "../evaluation/benchmark";
import type { BillingUsageSummary } from "./billing";

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function BillingUsage({ usage }: { usage: BillingUsageSummary }) {
  const cache = usage.modelTokens.cacheRead + usage.modelTokens.cacheWrite;
  return (
    <section aria-label="Recorded Usage">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Recorded Usage</h2>
        <span className="text-xs text-muted-foreground">All Time</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <UsagePanel title="LLM Usage">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Metric label="Tokens" value={usage.tokens.toLocaleString()} />
            <Metric label="Billable Amount" value={dollars(usage.modelBillableUsd)} />
            <Metric label="Input" value={usage.modelTokens.input.toLocaleString()} />
            <Metric label="Output" value={usage.modelTokens.output.toLocaleString()} />
            <Metric label="Cache" value={cache.toLocaleString()} />
          </div>
        </UsagePanel>
        <UsagePanel title="Sandbox Usage">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Metric label="Runtime" value={duration(usage.sandboxSeconds)} />
            <Metric label="Billable Amount" value={dollars(usage.sandboxBillableUsd)} />
            <Metric label="Minutes" value={(usage.sandboxSeconds / 60).toFixed(1)} />
          </div>
        </UsagePanel>
      </div>
    </section>
  );
}

function UsagePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel p-4" aria-label={title}>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
