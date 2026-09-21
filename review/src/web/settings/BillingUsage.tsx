import type { ReactNode } from "react";
import { dollars } from "../evaluation/benchmark";
import type { BillingUsageSummary } from "./billing";

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function metricCost(value: number | undefined): string {
  return value === undefined ? "Not Available" : dollars(value);
}

export function BillingUsage({ usage }: { usage: BillingUsageSummary }) {
  const cache = usage.modelTokens.cacheRead + usage.modelTokens.cacheWrite;
  return (
    <section aria-label="Recorded Usage">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Recorded Usage</h2>
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">All Time</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <UsagePanel title="LLM Usage">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Metric label="Tokens" value={usage.tokens.toLocaleString()} />
            <Metric label="Estimated Cost" value={metricCost(usage.modelCostUsd)} />
            <Metric label="Input" value={usage.modelTokens.input.toLocaleString()} />
            <Metric label="Output" value={usage.modelTokens.output.toLocaleString()} />
            <Metric label="Cache" value={cache.toLocaleString()} />
          </div>
        </UsagePanel>
        <UsagePanel title="Sandbox Usage">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Metric label="Runtime" value={duration(usage.sandboxSeconds)} />
            <Metric label="Estimated Cost" value={metricCost(usage.sandboxCostUsd)} />
            <Metric label="Minutes" value={(usage.sandboxSeconds / 60).toFixed(1)} />
          </div>
        </UsagePanel>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Costs are estimates from recorded token and sandbox usage. Provider credentials are billed
        by their providers; managed usage is billed through SelfBench.
      </p>
    </section>
  );
}

function UsagePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-muted/20 p-4" aria-label={title}>
      <h3 className="mb-3 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
