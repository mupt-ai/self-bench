/**
 * Re-derives trial cost fields from a finished evaluation's stored Harbor artifacts, for runs
 * recorded before a cost fix shipped.
 *
 *   node dist/evaluation/recompute-cost.js <repoId> <evaluationId>           # dry run
 *   node dist/evaluation/recompute-cost.js <repoId> <evaluationId> --apply   # save a snapshot
 *
 * Reads the artifact store from the usual SELFBENCH_ARTIFACT_* / SELFBENCH_GCS_* settings. Runs
 * recorded before the model credential's sign-in type was saved with the evaluation look it up in
 * SELFBENCH_DATABASE_URL when set; without it, Codex sign-in cache writes are not inferred. Apply
 * appends a new snapshot and never rewrites old ones, so the previous revision stays readable.
 * Only the cost fields change. It refuses runs that are still queued or running.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type ArtifactStore, createArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../contracts/config/index.js";
import { openDatabase } from "../db/client.js";
import { credentials } from "../db/schema.js";
import { trialCost } from "./cost.js";
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
): Promise<ModelAuth | undefined> {
  if (run.credentials?.auth) return run.credentials.auth;
  if (run.credentials?.modelCredentialId === "managed-model") return "api-key";
  const orgId = run.credentialOrgId ?? run.credentialOwnerId;
  if (!lookup || !run.credentials || !orgId) return undefined;
  return lookup(orgId, run.credentials.modelCredentialId);
}

export async function recomputeEvaluationCost(
  store: ArtifactStore,
  repoId: number,
  id: string,
  apply: boolean,
  lookup?: ModelAuthLookup,
): Promise<RecomputeReport> {
  const run = await getEvaluation(store, repoId, id);
  if (!run) throw new Error("Evaluation not found");
  if (run.status === "queued" || run.status === "running")
    throw new Error("Evaluation is still in progress");
  const auth = await modelAuth(run, lookup);
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
    if (!result) {
      report.trials.push({ index, before, changed: false });
      continue;
    }
    const after = trialCost(run, trial.harness, files, record(JSON.parse(result[1])), auth);
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
    throw new Error("Usage: recompute-cost.js <repoId> <evaluationId> [--apply]");
  const store = createArtifactStore(loadConfig().artifact);
  const url = process.env.SELFBENCH_DATABASE_URL;
  const database = url ? await openDatabase(url, { light: true }) : undefined;
  try {
    const lookup: ModelAuthLookup | undefined = database
      ? async (orgId, credentialId) => {
          if (!z.uuid().safeParse(credentialId).success) return undefined;
          const [row] = await database.db
            .select({ auth: credentials.auth })
            .from(credentials)
            .where(and(eq(credentials.orgId, orgId), eq(credentials.id, credentialId)));
          return row?.auth === "codex-login" || row?.auth === "api-key" ? row.auth : undefined;
        }
      : undefined;
    const report = await recomputeEvaluationCost(
      store,
      Number(repoId),
      id,
      process.argv.includes("--apply"),
      lookup,
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await database?.close();
  }
}
