import type { ReactNode } from "react";
import { EmptyState } from "../ui";
import { type BillingUsageSummary, formatBillingDollars } from "./billing";

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function BillingUsage({ usage }: { usage: BillingUsageSummary }) {
  const tokenSegments = [
    { label: "Input", value: usage.modelTokens.input, className: "bg-brand" },
    { label: "Output", value: usage.modelTokens.output, className: "bg-foreground/70" },
    { label: "Cache Read", value: usage.modelTokens.cacheRead, className: "bg-foreground/35" },
    { label: "Cache Write", value: usage.modelTokens.cacheWrite, className: "bg-foreground/15" },
  ];
  const totalCost = usage.modelBillableUsd + usage.sandboxBillableUsd;
  const hasUsage = usage.tokens > 0 || usage.sandboxSeconds > 0 || totalCost > 0;

  return (
    <section aria-labelledby="recorded-usage-title">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="recorded-usage-title" className="text-sm font-medium">
            Recorded Usage
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            All managed usage recorded for this organization.
          </p>
        </div>
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">All Time</span>
      </div>
      {!hasUsage ? (
        <EmptyState title="No Managed Usage Yet">
          Model token and sandbox runtime totals will appear here after the first managed run.
        </EmptyState>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <UsagePanel title="Model Usage">
            <dl className="flex items-end justify-between gap-4 border-b border-border pb-4">
              <Metric label="Tokens" value={usage.tokens.toLocaleString()} prominent />
              <Metric
                label="Billable Amount"
                value={formatBillingDollars(usage.modelBillableUsd)}
                align="right"
              />
            </dl>
            <div
              className="mt-4 flex h-2 w-full overflow-hidden bg-muted"
              role="img"
              aria-label={tokenSegments
                .map(({ label, value }) => `${label}: ${value.toLocaleString()} tokens`)
                .join(", ")}
            >
              {tokenSegments
                .filter(({ value }) => value > 0)
                .map(({ label, value, className }) => (
                  <span key={label} className={className} style={{ flexGrow: value }} />
                ))}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              {tokenSegments.map(({ label, value, className }) => (
                <div key={label}>
                  <dt className="flex items-center gap-2 text-[10px] tracking-wider text-muted-foreground uppercase">
                    <span className={`size-1.5 ${className}`} aria-hidden="true" />
                    {label}
                  </dt>
                  <dd className="mt-1 text-xs tabular-nums text-foreground">
                    {value.toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>
          </UsagePanel>
          <UsagePanel title="Sandbox Usage">
            <dl className="grid grid-cols-2 gap-4 border-b border-border pb-4">
              <Metric label="Runtime" value={duration(usage.sandboxSeconds)} prominent />
              <Metric
                label="Billable Amount"
                value={formatBillingDollars(usage.sandboxBillableUsd)}
                align="right"
              />
            </dl>
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <Metric
                label="Runtime in Minutes"
                value={(usage.sandboxSeconds / 60).toLocaleString(undefined, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                })}
              />
              <Metric
                label="Share of Recorded Cost"
                value={
                  totalCost > 0
                    ? `${((usage.sandboxBillableUsd / totalCost) * 100).toFixed(1)}%`
                    : "0%"
                }
                align="right"
              />
            </dl>
          </UsagePanel>
        </div>
      )}
    </section>
  );
}

function UsagePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-border bg-card p-4" aria-label={title}>
      <h3 className="mb-4 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  prominent = false,
  align = "left",
}: {
  label: string;
  value: string;
  prominent?: boolean;
  align?: "left" | "right";
}) {
  return (
    <div className={align === "right" ? "text-right" : undefined}>
      <dt className="text-[10px] tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd
        className={`mt-1 tabular-nums text-foreground ${prominent ? "text-xl font-medium" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}
