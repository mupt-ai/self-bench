import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { createRunSummaryStore } from "../src/db/evaluation-summaries.js";
import { credentials, evaluationSummaries, releases } from "../src/db/schema.js";
import { dariTrialCost } from "../src/evaluation/dari/cost.js";
import { getEvaluation, keepRunSummaries, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationTrial } from "../src/evaluation/types.js";
import { canonicalJson, sha256 } from "../src/lib/hash.js";
import { frontierOf } from "../src/public/release-rule.js";
import { settingIdOf } from "../src/public/release-trials.js";
import type { ReleasePayload } from "../src/public/release-types.js";
import { modelAuth, storedHarborFiles } from "./recompute-cost.js";
import { partialCodexCost } from "./partial-cost.js";

/** Backed-up, evidence-only repair. Missing amounts remain unknown; existing complete prices stay. */
export async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.SELFBENCH_DATABASE_URL;
  if (!url) throw new Error("Set SELFBENCH_DATABASE_URL and artifact settings");
  const database = await openDatabase(url, { light: true });
  const store = createArtifactStore(loadConfig().artifact);
  keepRunSummaries(store, createRunSummaryStore(database.db));
  const backup = `maintenance/cost-coverage/${new Date().toISOString().replaceAll(":", "-")}`;
  const runs = new Map<string, Pick<EvaluationTrial, "apiCostUsd" | "costIncomplete">[]>();
  const report = { apply, backup, runsScanned: 0, runsChanged: 0, trialsRecovered: 0,
    trialsStillUnknown: 0, activeRunsSkipped: 0, releasesChanged: 0 };
  try {
    const auths = new Map((await database.db.select({ org: credentials.orgId, id: credentials.id, auth: credentials.auth }).from(credentials))
      .map(row => [`${row.org}/${row.id}`, row.auth]));
    const lookup = async (org: number, id: string) => {
      const auth = auths.get(`${org}/${id}`);
      return auth === "api-key" || auth === "codex-login" ? auth : undefined;
    };
    const rows = await database.db.select().from(evaluationSummaries);
    for (const row of rows) {
      const run = await getEvaluation(store, row, row.id);
      if (!run) continue;
      report.runsScanned++;
      if (report.runsScanned % 25 === 0) console.error(JSON.stringify({ scanned: report.runsScanned, recovered: report.trialsRecovered }));
      if (run.status === "running" || run.status === "queued") { report.activeRunsSkipped++; continue; }
      const original = JSON.stringify(run);
      const auth = await modelAuth(run, lookup, undefined);
      for (const trial of run.trials) {
        if (trial.apiCostUsd !== undefined && !trial.costIncomplete) continue;
        if (trial.status !== "completed" && trial.status !== "failed") continue;
        if (run.modelName !== "openai/dari/routing" && !(trial.harness === "codex" && run.credentials?.provider === "openai" && run.pricing && auth && trial.modelVerified)) {
          trial.costIncomplete = true;
          report.trialsStillUnknown++;
          continue;
        }
        if (run.modelName === "openai/dari/routing" && !trial.artifacts.some(name => name.endsWith("/dari-billing.jsonl"))) {
          trial.costIncomplete = true;
          report.trialsStillUnknown++;
          continue;
        }
        const { files } = await storedHarborFiles(store, run, trial);
        const returned = await dariTrialCost(run, trial, {}, files);
        const text = [...files].find(([name]) => name.endsWith("/trajectory.json"))?.[1];
        const recovered = returned.apiCostUsd !== undefined ? returned
          : text ? partialCodexCost(run, trial, text, auth === "codex-login" || auth === "api-key" ? auth : undefined) : undefined;
        if (recovered?.apiCostUsd !== undefined) {
          if (trial.apiCostUsd === undefined || recovered.apiCostUsd >= trial.apiCostUsd) {
            Object.assign(trial, recovered);
            if (!recovered.costIncomplete) delete trial.costIncomplete;
            report.trialsRecovered++;
            console.error(JSON.stringify({ recovered: run.id, repo: run.repoId, model: run.modelName,
              task: trial.taskId, cost: trial.apiCostUsd, incomplete: !!trial.costIncomplete }));
          }
        } else {
          trial.costIncomplete = true;
          report.trialsStillUnknown++;
        }
      }
      runs.set(run.id, run.trials.map(trial => ({ ...(trial.apiCostUsd !== undefined ? { apiCostUsd: trial.apiCostUsd } : {}), ...(trial.costIncomplete ? { costIncomplete: true as const } : {}) })));
      if (original === JSON.stringify(run)) continue;
      report.runsChanged++;
      if (apply) {
        // Append-only snapshots remain readable; retain an explicit repair backup as well.
        await store.put(`${backup}/runs/${run.repoId}/${run.id}.json`, Buffer.from(original), "application/json");
        const current = await getEvaluation(store, run, run.id);
        if (current?.revision !== run.revision) throw new Error(`Run ${run.id} changed during repair`);
        await saveEvaluation(store, run);
      }
    }
    for (const row of await database.db.select().from(releases)) {
      const payload = structuredClone(row.payload) as ReleasePayload;
      const detail = structuredClone(row.detail) as Record<string, unknown>;
      const results = detail.results as Record<string, Record<string, { evaluationId?: string; trialIndex?: number;
        costUsd?: number; costIncomplete?: true }>> | undefined;
      if (!results || !Array.isArray(detail.tasks)) throw new Error(`Release ${row.id} lacks auditable results`);
      for (const [key, tasks] of Object.entries(results)) {
        const setting = payload.settings.find(s => s.id === settingIdOf(key));
        if (!setting) continue;
        for (const result of Object.values(tasks)) {
          const trial = result.evaluationId ? runs.get(result.evaluationId)?.[result.trialIndex ?? -1] : undefined;
          if (trial?.apiCostUsd !== undefined && result.costUsd === undefined) {
            result.costUsd = trial.apiCostUsd;
            if (trial.costIncomplete) result.costIncomplete = true;
          }
        }
        const chosen = (detail.tasks as string[]).map(task => tasks[task]);
        const known = chosen.filter(t => typeof t?.costUsd === "number");
        setting.totalCostUsd = known.reduce((sum, t) => sum + (t?.costUsd ?? 0), 0);
        setting.costPerTaskUsd = setting.totalCostUsd / setting.tasks;
        setting.costedTasks = known.length;
        if (known.length !== setting.tasks || chosen.some(t => t?.costIncomplete)) setting.costIncomplete = true;
        else delete setting.costIncomplete;
      }
      const frontier = frontierOf(payload.settings.filter(s => !s.costIncomplete));
      for (const setting of payload.settings) setting.onFrontier = frontier.has(setting.id);
      payload.frontier = payload.settings.filter(s => s.onFrontier).map(s => s.id);
      if (isDeepStrictEqual(payload, row.payload) && isDeepStrictEqual(detail, row.detail)) continue;
      report.releasesChanged++;
      if (apply) {
        await store.put(`${backup}/releases/${row.id}.json`, Buffer.from(JSON.stringify(row)), "application/json");
        // Compare the complete old payload/detail: never race a publish/withdrawal or another repair.
        const changed = await database.db.update(releases).set({ payload, detail,
          hash: sha256(canonicalJson({ payload, results, declined: detail.declined })) })
          .where(and(eq(releases.id, row.id), eq(releases.hash, row.hash)))
          .returning({ id: releases.id });
        if (!changed.length) throw new Error(`Release ${row.id} changed during repair`);
      }
    }
    if (apply) await store.put(`${backup}/report.json`, Buffer.from(JSON.stringify(report)), "application/json");
    console.log(JSON.stringify(report));
  } finally { await database.close(); }
}
