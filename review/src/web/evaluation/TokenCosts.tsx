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
      <h4>Token Usage</h4>
      <dl className="my-4 flex flex-wrap gap-x-10 gap-y-6 font-mono text-sm [&_dt]:text-sm [&_dt]:text-muted [&_dd]:mt-2 [&_dd]:text-ink">
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
      <p className="mt-2 text-base text-muted">
        {trial.apiCostUsd === undefined
          ? "Cost unavailable: incomplete pricing or usage records."
          : `${trial.costSource === "harbor" ? "Harbor’s per-request" : "Reference-rate"} estimate from token usage. Not an invoice; sandbox charges excluded.`}
      </p>
    </section>
  );
}
