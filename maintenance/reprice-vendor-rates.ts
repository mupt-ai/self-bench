/**
 * Reprices a finished gateway evaluation at its model vendor's undiscounted list rates, as new
 * gateway runs are priced (runPricing), for runs recorded at a gateway's list price, which can
 * carry a launch discount or another provider's rates, or at a gateway's charge.
 *
 *   node dist/maintenance/reprice-vendor-rates.js <repoId> <evaluationId>           # dry run
 *   node dist/maintenance/reprice-vendor-rates.js <repoId> <evaluationId> --apply   # save a snapshot
 *
 * Reads the artifact store from the usual SELFBENCH_ARTIFACT_* / SELFBENCH_GCS_* settings and the
 * rates from OpenRouter, and refuses when OpenRouter does not list the vendor serving the model.
 * Each trial is priced from the token usage the runner recorded from whole transcripts, which
 * stored ones may no longer be. A gateway's recorded charge moves to billedCostUsd. A trial the
 * rates cannot price whole keeps its cost: Claude Code's (its cache lifetimes are not recorded),
 * or, under a long-context bound or tiers, one whose requests may have crossed them; a
 * reference-rate cost under an earlier bound no further out checked each request. Only the
 * pricing and cost fields change; apply appends a new snapshot and never rewrites old ones. It
 * refuses runs that are still queued or running.
 */
import { type ArtifactStore, createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { baseRatesLimit } from "../src/contracts/models.js";
import { evaluationCatalog, vendorModelId } from "../src/evaluation/catalog.js";
import { referenceCost } from "../src/evaluation/request-cost.js";
import { getEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationTrial } from "../src/evaluation/types.js";
import { isGateway } from "../src/gateways/index.js";
import { refreshGateway } from "../src/gateways/refresh.js";
import { atVendorRates, vendorListRates } from "../src/gateways/vendor-pricing.js";

type Priced = Pick<EvaluationTrial, "apiCostUsd" | "costSource" | "billedCostUsd">;

interface RepriceReport {
  pricing: { before: unknown; after: unknown };
  trials: { index: number; before: Priced; after?: Priced }[];
  totalCostUsd: { before: number; after: number };
  applied: boolean;
}

const priced = ({ apiCostUsd, costSource, billedCostUsd }: EvaluationTrial): Priced => ({
  ...(apiCostUsd === undefined ? {} : { apiCostUsd }),
  ...(costSource === undefined ? {} : { costSource }),
  ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
});

export async function repriceEvaluation(
  store: ArtifactStore,
  repoId: number,
  id: string,
  apply: boolean,
  fetcher: typeof fetch = fetch,
): Promise<RepriceReport> {
  const run = await getEvaluation(store, repoId, id);
  if (!run) throw new Error("Evaluation not found");
  if (run.status === "queued" || run.status === "running")
    throw new Error("Evaluation is still in progress");
  if (!isGateway(run.credentials?.provider) || !run.pricing)
    throw new Error("Only priced gateway evaluations take vendor list rates");
  const model = evaluationCatalog().find((entry) => entry.id === run.model) ?? { id: run.model };
  const vendorId = vendorModelId(model);
  const vendor = await vendorListRates(vendorId, fetcher);
  if (!vendor) throw new Error(`OpenRouter lists no vendor rates for ${vendorId}`);
  const before = run.pricing;
  const pricing = atVendorRates(before, vendor, new Date().toISOString().slice(0, 10));
  const limit = baseRatesLimit(pricing);
  run.pricing = pricing;
  const report: RepriceReport = {
    pricing: { before, after: pricing },
    trials: [],
    totalCostUsd: { before: 0, after: 0 },
    applied: false,
  };
  for (const [index, trial] of run.trials.entries()) {
    const was = priced(trial);
    report.totalCostUsd.before += trial.apiCostUsd ?? 0;
    const usage = trial.tokenUsage;
    const whole =
      usage &&
      trial.modelVerified &&
      trial.harness !== "claude-code" &&
      !trial.cacheWritesInferred &&
      // Totals price at the base rates only when every request was within them: a reference-rate
      // cost under the run's earlier bound checked each request against it.
      (limit === undefined ||
        (trial.costSource === "reference-rates" &&
          !before.longContext &&
          (baseRatesLimit(before) ?? Number.POSITIVE_INFINITY) <= limit));
    if (whole) {
      const billedCostUsd = trial.costSource === "gateway" ? trial.apiCostUsd : trial.billedCostUsd;
      Object.assign(trial, {
        apiCostUsd: referenceCost(pricing, usage),
        costSource: "reference-rates",
      });
      if (billedCostUsd !== undefined) trial.billedCostUsd = billedCostUsd;
      report.trials.push({ index, before: was, after: priced(trial) });
    } else report.trials.push({ index, before: was });
    report.totalCostUsd.after += trial.apiCostUsd ?? 0;
  }
  if (apply) {
    await saveEvaluation(store, run);
    report.applied = true;
  }
  return report;
}

export async function main(): Promise<void> {
  const [repoId, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!repoId || !/^\d+$/.test(repoId) || !id)
    throw new Error("Usage: reprice-vendor-rates.js <repoId> <evaluationId> [--apply]");
  const store = createArtifactStore(loadConfig().artifact);
  // The catalog pairs a model's ids across gateways, which finds OpenRouter's id for a model a
  // run named by another gateway's.
  await Promise.all(
    (["openrouter", "vercel-ai-gateway"] as const).map((gateway) => refreshGateway(gateway)),
  );
  const report = await repriceEvaluation(
    store,
    Number(repoId),
    id,
    process.argv.includes("--apply"),
  );
  console.log(JSON.stringify(report, null, 2));
}
