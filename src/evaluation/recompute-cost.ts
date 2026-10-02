/**
 * Re-derives trial cost fields from a finished evaluation's stored Harbor artifacts, for runs
 * recorded before a cost fix shipped.
 *
 *   node dist/evaluation/recompute-cost.js <repoId> <evaluationId>           # dry run
 *   node dist/evaluation/recompute-cost.js <repoId> <evaluationId> --apply   # save a snapshot
 *
 * Reads the artifact store from the usual SELFBENCH_ARTIFACT_* / SELFBENCH_GCS_* settings. Runs
 * recorded before the model credential's sign-in type was saved with the evaluation look it up in
 * SELFBENCH_DATABASE_URL when set, else take it from --auth=codex-login|api-key; without either,
 * Codex sign-in cache writes are not inferred. A sign-in type recorded or saved always wins over
 * the flag. A trial whose stored transcript is cut too far to count again keeps its cost. Apply
 * appends a new snapshot and never rewrites old ones, so the previous revision stays readable.
 * Only the cost fields and the pricing's long-context bound change: runs recorded before the bound
 * came from the vendor's or gateway's pricing carried a flat 200k one, so it is re-derived from the
 * catalog and each gateway's current listing (loaded first), while the recorded rates stay. A
 * trial that bound left unpriced, and whose stored transcript is cut too far to count again, is
 * priced from its recorded token usage once its pricing has no bound (recordedUsageCost). It refuses runs that are
 * still queued or running.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type ArtifactStore, createArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../contracts/config/index.js";
import { openDatabase } from "../db/client.js";
import { gatewayIds, isGateway } from "../gateways/index.js";
import { refreshGateway } from "../gateways/refresh.js";
import { HOUR_CACHE_WRITE_MULTIPLIER } from "../harnesses/claude-code/cost.js";
import { releaseCredentials } from "../public/release-sources.js";
import { withReferencePricing } from "./catalog.js";
import { referenceCost, trialCost } from "./cost.js";
import { evaluationCredentialOrg } from "./execution.js";
import { record } from "./output.js";
import { evaluationPrefix, getEvaluation, saveEvaluation } from "./store.js";
import type { EvaluationRun, EvaluationTrial } from "./types.js";

export type ModelAuth = NonNullable<NonNullable<EvaluationRun["credentials"]>["auth"]>;
/** The sign-in type of a saved model credential, deleted ones included. */
export type ModelAuthLookup = (
  orgId: number,
  credentialId: string,
) => Promise<ModelAuth | undefined>;

export type CostFields = Pick<
  EvaluationTrial,
  "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource" | "cacheWritesInferred"
>;
export const costKeys = [
  "modelVerified",
  "apiCostUsd",
  "tokenUsage",
  "costSource",
  "cacheWritesInferred",
] as const;

interface RecomputeReport {
  status: string;
  auth: ModelAuth | "unknown";
  maxInputTokens: { before: number | undefined; after: number | undefined; changed: boolean };
  trials: { index: number; before: CostFields; after?: CostFields; changed: boolean }[];
  applied: boolean;
}

export const costFields = (trial: CostFields): CostFields =>
  Object.fromEntries(
    costKeys.flatMap((key) => (trial[key] === undefined ? [] : [[key, trial[key]]])),
  );

/** A trial's stored transcripts and Harbor result, named as the runner collected them. */
export async function storedHarborFiles(
  store: ArtifactStore,
  run: EvaluationRun,
  trial: EvaluationTrial,
): Promise<{ files: Map<string, string>; result: string | undefined }> {
  const files = new Map<string, string>();
  for (const name of trial.artifacts) {
    if (!/\/(trajectory\.json|pi\.txt|result\.json)$/.test(name)) continue;
    const bytes = await store.getByKey(`${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`);
    if (bytes) files.set(name.slice(name.indexOf("/") + 1), Buffer.from(bytes).toString("utf8"));
  }
  const result = [...files].find(([name]) => /^solver\/[^/]+\/result\.json$/.test(name))?.[1];
  return { files, result };
}

/** The sign-in type a run's model credential used: recorded, saved, or else `fallback`. */
export async function modelAuth(
  run: EvaluationRun,
  lookup: ModelAuthLookup | undefined,
  fallback: ModelAuth | undefined,
): Promise<ModelAuth | undefined> {
  if (run.credentials?.auth) return run.credentials.auth;
  if (run.credentials?.modelCredentialId === "managed-model") return "api-key";
  const orgId = evaluationCredentialOrg(run);
  const saved =
    lookup && run.credentials && orgId
      ? await lookup(orgId, run.credentials.modelCredentialId)
      : undefined;
  return saved ?? fallback;
}

/** The run's pricing with the long-context bound its route's pricing has now, if it is known. */
function currentBound(run: EvaluationRun): EvaluationRun["pricing"] {
  const provider = run.credentials?.provider;
  if (!run.pricing || !provider) return run.pricing;
  if (provider !== "openai" && provider !== "anthropic" && !isGateway(provider)) return run.pricing;
  const now = withReferencePricing({
    id: run.model,
    provider,
    model: run.modelName.slice(provider.length + 1),
    label: run.model,
    harnesses: [],
    source: "",
  }).pricing;
  if (!now) return run.pricing;
  const { maxInputTokens: _recorded, ...rates } = run.pricing;
  return now.maxInputTokens === undefined
    ? rates
    : { ...rates, maxInputTokens: now.maxInputTokens };
}

/**
 * Cost fields for a trial priced from its recorded token usage, when that is a whole price: the
 * pricing bounds no request, and the usage splits into the buckets the rates price. Claude Code
 * records no split of its cache writes by lifetime, but it reports its own cost (`reported`, in
 * Harbor's result), which fixes the split: the trial is priced only when that cost leaves a whole
 * number of hour-long writes and is reproduced at the recorded rates.
 */
function recordedUsageCost(
  run: EvaluationRun,
  trial: EvaluationTrial,
  auth: ModelAuth | undefined,
  reported: unknown,
): CostFields | undefined {
  const { pricing } = run;
  const usage = trial.tokenUsage;
  if (!pricing || pricing.maxInputTokens || !usage || !trial.modelVerified) return undefined;
  if (trial.apiCostUsd !== undefined || trial.cacheWritesInferred) return undefined;
  if (trial.harness === "codex" && auth !== "api-key") return undefined;
  let hourCacheWrite = 0;
  if (trial.harness === "claude-code") {
    if (typeof reported !== "number") return undefined;
    // Each hour-long write costs this much more than a five-minute one.
    const premium = (pricing.input * HOUR_CACHE_WRITE_MULTIPLIER - pricing.cacheWrite) / 1_000_000;
    const hours = premium ? (reported - referenceCost(pricing, usage)) / premium : 0;
    hourCacheWrite = Math.round(hours);
    if (Math.abs(hours - hourCacheWrite) > 0.01 || hourCacheWrite < 0) return undefined;
    if (hourCacheWrite > usage.cacheWrite) return undefined;
  }
  const apiCostUsd = referenceCost(pricing, usage, hourCacheWrite);
  if (!Number.isFinite(apiCostUsd)) return undefined;
  if (trial.harness === "claude-code" && Math.abs(apiCostUsd - Number(reported)) > 1e-6)
    return undefined;
  return { modelVerified: true, tokenUsage: usage, apiCostUsd, costSource: "reference-rates" };
}

export async function recomputeEvaluationCost(
  store: ArtifactStore,
  repoId: number,
  id: string,
  apply: boolean,
  lookup?: ModelAuthLookup,
  fallbackAuth?: ModelAuth,
): Promise<RecomputeReport> {
  const run = await getEvaluation(store, repoId, id);
  if (!run) throw new Error("Evaluation not found");
  if (run.status === "queued" || run.status === "running")
    throw new Error("Evaluation is still in progress");
  const auth = await modelAuth(run, lookup, fallbackAuth);
  const before = run.pricing?.maxInputTokens;
  const pricing = currentBound(run);
  if (pricing) run.pricing = pricing;
  const after = run.pricing?.maxInputTokens;
  const report: RecomputeReport = {
    status: run.status,
    auth: auth ?? "unknown",
    maxInputTokens: { before, after, changed: before !== after },
    trials: [],
    applied: false,
  };
  for (const [index, trial] of run.trials.entries()) {
    const before = costFields(trial);
    const { files, result } = await storedHarborFiles(store, run, trial);
    // Without the sign-in type, an earlier recompute's inferred cache writes cannot be rederived.
    if (!result || (!auth && trial.cacheWritesInferred)) {
      report.trials.push({ index, before, changed: false });
      continue;
    }
    const parsed = record(JSON.parse(result));
    const after = trialCost(run, trial.harness, files, parsed, auth);
    // The runner reads transcripts whole; stored ones can be cut too far to count again.
    if (before.tokenUsage && !after.tokenUsage) {
      const reported = record(parsed.agent_result).cost_usd;
      const recorded = recordedUsageCost(run, trial, auth, reported);
      if (recorded) {
        report.trials.push({ index, before, after: recorded, changed: true });
        Object.assign(trial, recorded);
      } else report.trials.push({ index, before, changed: false });
      continue;
    }
    const changed = !isDeepStrictEqual(before, after);
    report.trials.push({ index, before, after, changed });
    if (changed) {
      for (const key of costKeys) delete trial[key];
      Object.assign(trial, after);
    }
  }
  if (apply && (report.maxInputTokens.changed || report.trials.some((trial) => trial.changed))) {
    await saveEvaluation(store, run);
    report.applied = true;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repoId, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!repoId || !/^\d+$/.test(repoId) || !id)
    throw new Error(
      "Usage: recompute-cost.js <repoId> <evaluationId> [--apply] [--auth=codex-login|api-key]",
    );
  const flag = process.argv.find((arg) => arg.startsWith("--auth="))?.slice("--auth=".length);
  if (flag !== undefined && flag !== "codex-login" && flag !== "api-key")
    throw new Error("--auth must be codex-login or api-key");
  const store = createArtifactStore(loadConfig().artifact);
  // A gateway route's bound comes from the gateway's listing, not the reference rates.
  await Promise.all(gatewayIds.map((gateway) => refreshGateway(gateway)));
  const url = process.env.SELFBENCH_DATABASE_URL;
  const database = url ? await openDatabase(url, { light: true }) : undefined;
  try {
    const lookup: ModelAuthLookup | undefined = database
      ? async (orgId, credentialId) =>
          (await releaseCredentials(database.db, orgId)).get(credentialId)?.auth
      : undefined;
    const report = await recomputeEvaluationCost(
      store,
      Number(repoId),
      id,
      process.argv.includes("--apply"),
      lookup,
      flag,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await database?.close();
  }
}
