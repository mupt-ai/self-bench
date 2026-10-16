/**
 * Scores the trials of a repository's or benchmark's evaluations that failed only on a time limit,
 * for runs recorded before such trials counted (runner.ts): one whose agent Harbor stopped takes
 * the verifier's scores, and one whose tests ran past their limit fails with a reward of 0. Each
 * takes its cost from its stored Harbor artifacts, as the runner gives it now.
 *
 *   node dist/maintenance/backfill-timeouts.js <repoId>... [benchmark:<id>...]           # dry run
 *   node dist/maintenance/backfill-timeouts.js <repoId>... [benchmark:<id>...] --apply   # save
 *
 * Reads the artifact store and model sign-in types as recompute-cost.js does. A stopped agent's
 * trial whose result has no scores, or a trial whose Pi stopped on a model error, stays failed. Apply
 * appends a new snapshot to each changed run and never rewrites old ones; a finished run whose
 * trials then all completed is completed. Runs still going are safe to backfill: the change is
 * applied to the latest record, and only to a trial still failed on its timeout.
 */
import { type ArtifactStore, createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { trialCost } from "../src/evaluation/cost.js";
import { eligibleTrial } from "../src/evaluation/eligible.js";
import { agentTimedOut, piFailure, record, timeLimitScores } from "../src/evaluation/output.js";
import type { EvaluationScope } from "../src/evaluation/scope.js";
import {
  type CostFields,
  costFields,
  costKeys,
  type ModelAuth,
  type ModelAuthLookup,
  modelAuth,
  storedHarborFiles,
} from "./recompute-cost.js";
import { listEvaluations, updateEvaluation } from "../src/evaluation/store.js";
import type { EvaluationRun, EvaluationTrial } from "../src/evaluation/types.js";
import { releaseCredentials } from "../src/public/release-sources.js";

/** The errors the runner recorded for a trial that Harbor stopped at the agent's or tests' limit. */
const TIMED_OUT = /^(?:Agent|Verifier) execution timed out after /;

type Scored = Pick<EvaluationTrial, "rewards" | "agentTimedOut" | "verifierTimedOut"> & CostFields;

interface BackfillReport {
  scope: EvaluationScope;
  runs: {
    id: string;
    trials: { index: number; scored?: Scored; eligible?: boolean; skipped?: string }[];
  }[];
  scored: number;
  eligible: number;
  skipped: number;
  applied: boolean;
}

/** A timed-out trial's scores and cost from its stored Harbor artifacts, or why it has none. */
async function scoreTrial(
  store: ArtifactStore,
  run: EvaluationRun,
  trial: EvaluationTrial,
  auth: ModelAuth | undefined,
): Promise<Scored | string> {
  const { files, result } = await storedHarborFiles(store, run, trial);
  if (result === undefined) return "no Harbor result";
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(result));
  } catch {
    return "unreadable Harbor result";
  }
  const scores = timeLimitScores(parsed);
  if (!scores)
    return agentTimedOut(parsed)
      ? "no verifier scores"
      : "Harbor did not stop the trial at a time limit";
  const pi = [...files].find(([name]) => name.endsWith("/pi.txt"));
  const failure = pi && piFailure(pi[1]);
  if (failure) return `Pi stopped on a model error: ${failure}`;
  // The runner measured the whole transcript before the timeout failed the trial; a stored one
  // can be cut too far to measure again. Only the trials it could not measure are priced here.
  const cost = trial.tokenUsage
    ? costFields(trial)
    : trialCost(run, trial.harness, files, parsed, auth);
  return { ...scores, ...cost };
}

/** Completes a timed-out trial on its scores, replacing whatever cost it had. */
function complete(trial: EvaluationTrial, scored: Scored): void {
  for (const key of costKeys) delete trial[key];
  delete trial.error;
  Object.assign(trial, scored, { status: "completed" });
}

export async function backfillTimeouts(
  store: ArtifactStore,
  scope: EvaluationScope,
  apply: boolean,
  lookup?: ModelAuthLookup,
  fallbackAuth?: ModelAuth,
): Promise<BackfillReport> {
  const report: BackfillReport = {
    scope,
    runs: [],
    scored: 0,
    eligible: 0,
    skipped: 0,
    applied: false,
  };
  for (const run of await listEvaluations(store, scope)) {
    const candidates = [...run.trials.entries()].filter(
      ([, trial]) => trial.status === "failed" && TIMED_OUT.test(trial.error ?? ""),
    );
    if (candidates.length === 0) continue;
    const auth = await modelAuth(run, lookup, fallbackAuth);
    const scored = new Map<number, Scored>();
    const entry: BackfillReport["runs"][number] = { id: run.id, trials: [] };
    for (const [index, trial] of candidates) {
      const outcome = await scoreTrial(store, run, trial, auth);
      if (typeof outcome === "string") {
        entry.trials.push({ index, skipped: outcome });
        report.skipped += 1;
        continue;
      }
      scored.set(index, outcome);
      const preview = structuredClone(trial);
      complete(preview, outcome);
      const eligible = eligibleTrial(preview);
      entry.trials.push({ index, scored: outcome, eligible });
      report.scored += 1;
      if (eligible) report.eligible += 1;
    }
    report.runs.push(entry);
    if (!apply || scored.size === 0) continue;
    let changed = false;
    await updateEvaluation(store, scope, run.id, (latest) => {
      changed = false;
      for (const [index, outcome] of scored) {
        const trial = latest.trials[index];
        if (trial?.status !== "failed" || !TIMED_OUT.test(trial.error ?? "")) continue;
        complete(trial, outcome);
        changed = true;
      }
      if (!changed) return false;
      // finishEvaluation's rule; a run that failed as a whole keeps its error.
      if (
        latest.status === "failed" &&
        !latest.error &&
        latest.trials.every((trial) => trial.status === "completed")
      )
        latest.status = "completed";
    });
    if (changed) report.applied = true;
  }
  return report;
}

export async function main(): Promise<void> {
  const scopes = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--"))
    .map((arg): EvaluationScope | undefined => {
      if (/^\d+$/.test(arg)) return { repoId: Number(arg) };
      const benchmark = /^benchmark:(\d+)$/.exec(arg)?.[1];
      return benchmark ? { benchmarkId: Number(benchmark) } : undefined;
    });
  if (scopes.length === 0 || scopes.some((scope) => scope === undefined))
    throw new Error(
      "Usage: backfill-timeouts.js <repoId | benchmark:<id>>... [--apply] [--auth=codex-login|api-key]",
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
    for (const scope of scopes as EvaluationScope[]) {
      const report = await backfillTimeouts(
        store,
        scope,
        process.argv.includes("--apply"),
        lookup,
        flag,
      );
      console.log(JSON.stringify(report, null, 2));
    }
  } finally {
    await database?.close();
  }
}
