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
 * catalog and the run's gateway listing, while the recorded rates stay. A trial that bound left
 * unpriced, and whose stored transcript is cut too far to count again, is priced from its recorded
 * token usage (recordedUsageCost). It refuses runs that are still queued or running.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type ArtifactStore, createArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../contracts/config/index.js";
import { openDatabase } from "../db/client.js";
import { isGateway } from "../gateways/index.js";
import { refreshGateway } from "../gateways/refresh.js";
import { HOUR_CACHE_WRITE_MULTIPLIER } from "../harnesses/claude-code/cost.js";
import { releaseCredentials } from "../public/release-sources.js";
import { referencePricing } from "./catalog.js";
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
  const now = referencePricing(run.model, provider, run.modelName.slice(provider.length + 1));
  if (!now) return run.pricing;
  const { maxInputTokens: _recorded, ...rates } = run.pricing;
  return now.maxInputTokens === undefined
    ? rates
    : { ...rates, maxInputTokens: now.maxInputTokens };
}

/**
 * The cost Claude Code reported for a trial, from the result event that ends its stored stream.
 * Harbor's own figure can be a LiteLLM estimate instead, which prices every write as short-lived.
 */
async function claudeCodeCost(
  store: ArtifactStore,
  run: EvaluationRun,
  trial: EvaluationTrial,
): Promise<number | undefined> {
  const name = trial.artifacts.find((artifact) => artifact.endsWith("/claude-code.txt"));
  if (!name) return undefined;
  const bytes = await store.getByKey(`${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`);
  const lines = Buffer.from(bytes ?? [])
    .toString("utf8")
    .split("\n")
    .filter((line) => line.includes('"type":"result"'));
  for (const line of lines.reverse()) {
    try {
      const event = record(JSON.parse(line));
      const cost = event.total_cost_usd;
      if (event.type === "result")
        return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
    } catch {
      // A line cut by the stored tail, or a quoted result inside another event.
    }
  }
  return undefined;
}

/**
 * Cost fields for a trial priced from its recorded token usage, when that is a whole price: the
 * pricing bounds no request, and the usage splits into the buckets the rates price. Claude Code
 * records no split of its cache writes by lifetime, but the cost it reported (`reported`) fixes
 * it: the trial is priced only when that cost leaves a whole number of hour-long writes and is
 * reproduced at the recorded rates.
 */
function recordedUsageCost(
  run: EvaluationRun,
  trial: EvaluationTrial,
  auth: ModelAuth | undefined,
  reported: number | undefined,
): CostFields | undefined {
  const { pricing } = run;
  const usage = trial.tokenUsage;
  if (!pricing || pricing.maxInputTokens || !usage || !trial.modelVerified) return undefined;
  if (trial.apiCostUsd !== undefined || trial.cacheWritesInferred) return undefined;
  if (trial.harness === "codex" && auth !== "api-key") return undefined;
  let hourCacheWrite = 0;
  if (trial.harness === "claude-code") {
    if (reported === undefined) return undefined;
    // Each hour-long write costs this much more than a five-minute one.
    const premium = (pricing.input * HOUR_CACHE_WRITE_MULTIPLIER - pricing.cacheWrite) / 1_000_000;
    const hours = premium ? (reported - referenceCost(pricing, usage)) / premium : 0;
    hourCacheWrite = Math.round(hours);
    if (Math.abs(hours - hourCacheWrite) > 0.01 || hourCacheWrite < 0) return undefined;
    if (hourCacheWrite > usage.cacheWrite) return undefined;
  }
  const apiCostUsd = referenceCost(pricing, usage, hourCacheWrite);
  if (!Number.isFinite(apiCostUsd)) return undefined;
  // Claude Code priced at rates other than these leaves no whole split, or one that misses.
  if (reported !== undefined && Math.abs(apiCostUsd - reported) > 1e-6) return undefined;
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
  // A cost priced under a looser bound than the run's now may cover a request the rates do not.
  const tightened = after !== undefined && (before === undefined || after < before);
  const report: RecomputeReport = {
    status: run.status,
    auth: auth ?? "unknown",
    maxInputTokens: { before, after, changed: before !== after },
    trials: [],
    applied: false,
  };
  for (const [index, trial] of run.trials.entries()) {
    const before = costFields(trial);
    // A billed gateway cost cannot be reconstructed from token usage or stored transcripts.
    if (before.costSource === "gateway") {
      report.trials.push({ index, before, changed: false });
      continue;
    }
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
      const reported =
        trial.harness === "claude-code" ? await claudeCodeCost(store, run, trial) : undefined;
      const recorded =
        tightened && before.costSource === "reference-rates"
          ? { modelVerified: true, tokenUsage: before.tokenUsage }
          : recordedUsageCost(run, trial, auth, reported);
      if (recorded) {
        report.trials.push({ index, before, after: recorded, changed: true });
        for (const key of costKeys) delete trial[key];
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
  // A gateway route's bound comes from its gateway's listing, so a listing that fails to load
  // stops the recompute rather than falling back to reference rates.
  const provider = (await getEvaluation(store, Number(repoId), id))?.credentials?.provider;
  if (isGateway(provider)) await refreshGateway(provider);
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
