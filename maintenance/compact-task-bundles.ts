/**
 * Compacts the compile attempts of finished candidates, as the worker now does when a candidate
 * finishes (compactCandidate): each repository snapshot moves to one shared copy per content, and
 * each full bundle that no task row, saved comparison or release delivers goes once its gate task
 * and snapshot are shown to hold exactly its files.
 *
 *   node dist/maintenance/compact-task-bundles.js <runId>... | --all            # dry run
 *   node dist/maintenance/compact-task-bundles.js <runId>... | --all --apply    # compact
 *
 * Needs the artifact store and SELFBENCH_DATABASE_URL. Candidates without a task row, or still in
 * progress, are left alone. Deleted objects stay noncurrent in the versioned bucket until its
 * lifecycle rule removes them.
 */
import { createArtifactStore } from "../src/artifacts/index.js";
import { loadConfig } from "../src/contracts/config/index.js";
import { openDatabase } from "../src/db/client.js";
import { comparisons, releases, tasks } from "../src/db/schema.js";
import { type Compaction, compactCandidate, keptBundles } from "../src/generation/runs/compact.js";

const BUNDLE_KEY = /runs\/[A-Za-z0-9._/-]+?\.tar\.gz/g;

export async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const named = args.filter((arg) => !arg.startsWith("--"));
  if (all === named.length > 0 || named.some((run) => !/^[A-Za-z0-9._-]+$/.test(run)))
    throw new Error("Usage: compact-task-bundles.js <runId>... | --all [--apply]");
  const url = process.env.SELFBENCH_DATABASE_URL;
  if (!url) throw new Error("SELFBENCH_DATABASE_URL is required");
  const config = loadConfig();
  const store = createArtifactStore(config.artifact);
  const database = await openDatabase(url, { light: true });
  try {
    const rows = await database.db
      .select({
        runId: tasks.runId,
        candidateId: tasks.candidateId,
        bundleKey: tasks.bundleKey,
        pipelineStatus: tasks.pipelineStatus,
      })
      .from(tasks);
    // Accepted rows, deleted ones included: a deleted task's comparisons and releases still run it.
    const delivered = rows.flatMap((row) =>
      row.pipelineStatus === "accepted" && row.bundleKey ? [row.bundleKey] : [],
    );
    const saved = [
      ...(await database.db.select({ text: comparisons.inputs }).from(comparisons)),
      ...(await database.db.select({ text: releases.payload }).from(releases)),
      ...(await database.db.select({ text: releases.detail }).from(releases)),
    ].flatMap(({ text }) => JSON.stringify(text).match(BUNDLE_KEY) ?? []);
    const kept = keptBundles([...delivered, ...saved]);
    const finished = new Map(rows.map((row) => [`${row.runId}/${row.candidateId}`, row.pipelineStatus]));
    const runs = all ? await store.folders("runs") : named;
    const seen = new Set<string>();
    let total: Compaction = { snapshotsShared: 0, bundlesDeleted: 0, freedBytes: 0, mismatched: [] };
    for (const runId of runs) {
      let run: Compaction = { snapshotsShared: 0, bundlesDeleted: 0, freedBytes: 0, mismatched: [] };
      let skipped = 0;
      for (const candidateId of await store.folders(`runs/${runId}/verify`)) {
        const status = finished.get(`${runId}/${candidateId}`);
        if (!status || status === "in_progress") {
          skipped += 1;
          continue;
        }
        try {
          const done = await compactCandidate(store, runId, candidateId, { kept, apply, seen });
          run = {
            snapshotsShared: run.snapshotsShared + done.snapshotsShared,
            bundlesDeleted: run.bundlesDeleted + done.bundlesDeleted,
            freedBytes: run.freedBytes + done.freedBytes,
            mismatched: [...run.mismatched, ...done.mismatched],
          };
        } catch (error) {
          process.exitCode = 1;
          console.error(JSON.stringify({ runId, candidateId, status: "failed", reason: String(error) }));
        }
      }
      if (run.snapshotsShared || run.bundlesDeleted || run.mismatched.length || skipped)
        console.log(JSON.stringify({ runId, apply, skippedCandidates: skipped, ...summary(run) }));
      total = {
        snapshotsShared: total.snapshotsShared + run.snapshotsShared,
        bundlesDeleted: total.bundlesDeleted + run.bundlesDeleted,
        freedBytes: total.freedBytes + run.freedBytes,
        mismatched: [...total.mismatched, ...run.mismatched],
      };
    }
    console.log(JSON.stringify({ total: true, apply, ...summary(total) }));
    if (total.mismatched.length) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

function summary(compaction: Compaction) {
  return {
    snapshotsShared: compaction.snapshotsShared,
    bundlesDeleted: compaction.bundlesDeleted,
    freedGb: Math.round(compaction.freedBytes / 1e8) / 10,
    mismatched: compaction.mismatched,
  };
}
