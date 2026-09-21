import type { ReactNode } from "react";
import type { RunUsageSummary } from "../../../../src/managed/usage";
import { dollars } from "../evaluation/benchmark";

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function cost(value: number | undefined): string {
  return value === undefined ? "Not Available" : dollars(value);
}

export function BatchUsage({ usage }: { usage: RunUsageSummary }) {
  const cacheTokens = usage.modelTokens.cacheRead + usage.modelTokens.cacheWrite;
  return (
    <section className="mt-6 border-t border-border pt-4" aria-label="Batch Usage">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Usage</h2>
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
          Estimated
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <UsagePanel title="LLM Usage">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <UsageMetric label="Tokens" value={usage.tokens.toLocaleString()} />
            <UsageMetric label="Estimated Cost" value={cost(usage.modelCostUsd)} />
            <UsageMetric label="Input" value={usage.modelTokens.input.toLocaleString()} />
            <UsageMetric label="Output" value={usage.modelTokens.output.toLocaleString()} />
            <UsageMetric label="Cache" value={cacheTokens.toLocaleString()} />
          </div>
        </UsagePanel>
        <UsagePanel title="Sandbox Usage">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <UsageMetric label="Runtime" value={duration(usage.sandboxSeconds)} />
            <UsageMetric label="Estimated Cost" value={cost(usage.sandboxCostUsd)} />
            <UsageMetric label="Minutes" value={(usage.sandboxSeconds / 60).toFixed(1)} />
          </div>
        </UsagePanel>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Model and sandbox costs are estimates. Provider credentials are billed by their providers;
        managed usage is billed through SelfBench when billing is enabled.
      </p>
    </section>
  );
}

function UsagePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-muted/20 p-3" aria-label={title}>
      <h3 className="mb-3 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 text-sm tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
