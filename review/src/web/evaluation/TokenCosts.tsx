import type { EvaluationTrial } from "./api";
import { dollars } from "./benchmark";

export function TokenCosts({ trial }: { trial: EvaluationTrial }) {
  if (!trial.tokenUsage) return null;
  const usage = trial.tokenUsage;
  const counts = [
    ["Uncached Input", usage.input],
    ["Cached Input", usage.cacheRead],
    ["Cache Writes", usage.cacheWrite],
    ["Output", usage.output],
  ] as const;
  return (
    <section aria-label="Token Usage and Estimated Cost">
      <h4 className="text-sm font-medium">Token Usage</h4>
      <dl className="my-3 grid grid-cols-2 gap-4 border border-border bg-muted/30 p-4 sm:grid-cols-3 xl:grid-cols-5 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:text-sm [&_dd]:tabular-nums [&_dd]:text-foreground">
        {counts.map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count.toLocaleString()}</dd>
          </div>
        ))}
        <div>
          <dt>Estimated Model Cost</dt>
          <dd>{trial.apiCostUsd === undefined ? "Not Available" : dollars(trial.apiCostUsd)}</dd>
        </div>
      </dl>
      <p className="mb-6 text-xs text-muted-foreground">
        {trial.apiCostUsd === undefined
          ? "Cost unavailable: incomplete pricing or usage records."
          : `${trial.costSource === "harbor" ? "Harbor’s per-request" : "Reference-rate"} estimate from token usage. Not an invoice; sandbox charges excluded.`}
      </p>
    </section>
  );
}
