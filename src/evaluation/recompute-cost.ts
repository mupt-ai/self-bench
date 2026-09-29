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
 * Only the cost fields change. It refuses runs that are still queued or running.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type ArtifactStore, createArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../contracts/config/index.js";
import { openDatabase } from "../db/client.js";
import { releaseCredentials } from "../public/release-sources.js";
import { trialCost } from "./cost.js";
import { evaluationCredentialOrg } from "./execution.js";
import { record } from "./output.js";
import { evaluationPrefix, getEvaluation, saveEvaluation } from "./store.js";
import type { EvaluationRun, EvaluationTrial } from "./types.js";

type ModelAuth = NonNullable<NonNullable<EvaluationRun["credentials"]>["auth"]>;
/** The sign-in type of a saved model credential, deleted ones included. */
export type ModelAuthLookup = (
  orgId: number,
  credentialId: string,
) => Promise<ModelAuth | undefined>;

type CostFields = Pick<
  EvaluationTrial,
  "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource" | "cacheWritesInferred"
>;
const costKeys = [
  "modelVerified",
  "apiCostUsd",
  "tokenUsage",
  "costSource",
  "cacheWritesInferred",
] as const;

interface RecomputeReport {
  status: string;
  auth: ModelAuth | "unknown";
  trials: { index: number; before: CostFields; after?: CostFields; changed: boolean }[];
  applied: boolean;
}

const costFields = (trial: CostFields): CostFields =>
  Object.fromEntries(
    costKeys.flatMap((key) => (trial[key] === undefined ? [] : [[key, trial[key]]])),
  );

async function modelAuth(
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
  const report: RecomputeReport = {
    status: run.status,
    auth: auth ?? "unknown",
    trials: [],
    applied: false,
  };
  for (const [index, trial] of run.trials.entries()) {
    const before = costFields(trial);
    const names = trial.artifacts.filter((name) =>
      /\/(trajectory\.json|pi\.txt|result\.json)$/.test(name),
    );
    const files = new Map<string, string>();
    for (const name of names) {
      const bytes = await store.getByKey(`${evaluationPrefix(repoId, id)}artifacts/${name}`);
      if (bytes) files.set(name.slice(name.indexOf("/") + 1), Buffer.from(bytes).toString("utf8"));
    }
    const result = [...files].find(([name]) => /^solver\/[^/]+\/result\.json$/.test(name));
    // Without the sign-in type, an earlier recompute's inferred cache writes cannot be rederived.
    if (!result || (!auth && trial.cacheWritesInferred)) {
      report.trials.push({ index, before, changed: false });
      continue;
    }
    const after = trialCost(run, trial.harness, files, record(JSON.parse(result[1])), auth);
    // The runner reads transcripts whole; stored ones can be cut too far to count again.
    if (before.tokenUsage && !after.tokenUsage) {
      report.trials.push({ index, before, changed: false });
      continue;
    }
    const changed = !isDeepStrictEqual(before, after);
    report.trials.push({ index, before, after, changed });
    if (changed) {
      for (const key of costKeys) delete trial[key];
      Object.assign(trial, after);
    }
  }
  if (apply && report.trials.some((trial) => trial.changed)) {
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
