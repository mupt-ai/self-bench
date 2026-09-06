import type { EvaluationTrial } from "./api";
import { dollars } from "./benchmark";

export function TokenCosts({ trial }: { trial: EvaluationTrial }) {
  if (!trial.tokenUsage) return null;
  const usage = trial.tokenUsage;
  const counts = [
    ["Uncached input", usage.input],
    ["Cached input", usage.cacheRead],
    ["Cache writes", usage.cacheWrite],
    ["Output", usage.output],
  ] as const;
  return (
    <section aria-label="Token usage and estimated cost">
      <h4>Token usage</h4>
      <dl className="my-4 flex flex-wrap gap-x-10 gap-y-6 font-mono text-xs [&_dt]:text-[11px] [&_dt]:text-muted [&_dd]:mt-2 [&_dd]:text-ink">
        {counts.map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count.toLocaleString()}</dd>
          </div>
        ))}
        <div>
          <dt>Estimated model cost</dt>
          <dd>{trial.apiCostUsd === undefined ? "Not available" : dollars(trial.apiCostUsd)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[13px] text-muted">
        {trial.apiCostUsd === undefined
          ? "Cost unavailable: incomplete pricing or usage records."
          : `${trial.costSource === "harbor" ? "Harbor’s per-request" : "Reference-rate"} estimate from token usage. Not an invoice; sandbox charges excluded.`}
      </p>
    </section>
  );
}
