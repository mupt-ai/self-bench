/**
 * Scores the trials of a repository's evaluations that failed only because Harbor stopped their
 * agent at its time limit, for runs recorded before such trials counted (runner.ts). Each takes
 * the verifier's scores and a cost from its stored Harbor artifacts, as the runner gives it now.
 *
 *   node dist/evaluation/backfill-agent-timeouts.js <repoId>...           # dry run
 *   node dist/evaluation/backfill-agent-timeouts.js <repoId>... --apply   # save snapshots
 *
 * Reads the artifact store and model sign-in types as recompute-cost.js does. A trial whose result
 * has no scores, or whose Pi stopped on a model error before its time ran out, stays failed. Apply
 * appends a new snapshot to each changed run and never rewrites old ones; a finished run whose
 * trials then all completed is completed. Runs still going are safe to backfill: the change is
 * applied to the latest record, and only to a trial still failed on its timeout.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ArtifactStore, createArtifactStore } from "../artifacts/index.js";
import { loadConfig } from "../contracts/config/index.js";
import { openDatabase } from "../db/client.js";
import { releaseCredentials } from "../public/release-sources.js";
import { trialCost } from "./cost.js";
import { eligibleTrial } from "./eligible.js";
import { agentTimedOut, piFailure, record, verifierRewards } from "./output.js";
import { type ModelAuth, type ModelAuthLookup, modelAuth } from "./recompute-cost.js";
import { evaluationPrefix, listEvaluations, updateEvaluation } from "./store.js";
import type { EvaluationRun, EvaluationTrial } from "./types.js";

/** The error the runner recorded for a trial whose agent Harbor stopped at its time limit. */
const TIMED_OUT = /^Agent execution timed out after /;

type Scored = Pick<
  EvaluationTrial,
  "rewards" | "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource" | "cacheWritesInferred"
>;
const costKeys = [
  "modelVerified",
  "apiCostUsd",
  "tokenUsage",
  "costSource",
  "cacheWritesInferred",
] as const;

interface BackfillReport {
  repoId: number;
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
  const files = new Map<string, string>();
  for (const name of trial.artifacts.filter((name) =>
    /\/(trajectory\.json|pi\.txt|result\.json)$/.test(name),
  )) {
    const bytes = await store.getByKey(`${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`);
    if (bytes) files.set(name.slice(name.indexOf("/") + 1), Buffer.from(bytes).toString("utf8"));
  }
  const result = [...files].find(([name]) => /^solver\/[^/]+\/result\.json$/.test(name));
  if (!result) return "no Harbor result";
  const parsed = record(JSON.parse(result[1]));
  if (!agentTimedOut(parsed)) return "Harbor did not stop the agent at its time limit";
  const rewards = verifierRewards(parsed);
  if (Object.keys(rewards).length === 0) return "no verifier scores";
  const pi = [...files].find(([name]) => name.endsWith("/pi.txt"));
  const failure = pi && piFailure(pi[1]);
  if (failure) return `Pi stopped on a model error: ${failure}`;
  return { rewards, ...trialCost(run, trial.harness, files, parsed, auth) };
}

export async function backfillAgentTimeouts(
  store: ArtifactStore,
  repoId: number,
  apply: boolean,
  lookup?: ModelAuthLookup,
  fallbackAuth?: ModelAuth,
): Promise<BackfillReport> {
  const report: BackfillReport = {
    repoId,
    runs: [],
    scored: 0,
    eligible: 0,
    skipped: 0,
    applied: false,
  };
  for (const run of await listEvaluations(store, repoId)) {
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
      const eligible = eligibleTrial({ ...trial, ...outcome, status: "completed" });
      entry.trials.push({ index, scored: outcome, eligible });
      report.scored += 1;
      if (eligible) report.eligible += 1;
    }
    report.runs.push(entry);
    if (!apply || scored.size === 0) continue;
    await updateEvaluation(store, repoId, run.id, (latest) => {
      let changed = false;
      for (const [index, outcome] of scored) {
        const trial = latest.trials[index];
        if (trial?.status !== "failed" || !TIMED_OUT.test(trial.error ?? "")) continue;
        for (const key of costKeys) delete trial[key];
        delete trial.error;
        Object.assign(trial, outcome, { status: "completed", agentTimedOut: true });
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
    report.applied = true;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoIds = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (repoIds.length === 0 || !repoIds.every((id) => /^\d+$/.test(id)))
    throw new Error(
      "Usage: backfill-agent-timeouts.js <repoId>... [--apply] [--auth=codex-login|api-key]",
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
    for (const repoId of repoIds) {
      const report = await backfillAgentTimeouts(
        store,
        Number(repoId),
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
