import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts/index.js";
import {
  evaluationPrefix,
  getEvaluation,
  keepSummary,
  listEvaluations,
  runSummariesOf,
  runSummary,
  savedSince,
} from "./store.js";
import type { EvaluationRun } from "./types.js";

/**
 * A repository's runs as lists show them: each run's summary (runSummary), newest first.
 *
 * A run's record is megabytes of transcripts, and a list needs none of them, so each save also
 * writes the summary to the database (saveSummary in store.ts) and a list reads those. The bucket stays the
 * truth: it names the runs, and a summary counts only while its run has not been saved since. One
 * that is missing or behind (a run from before summaries, a worker on older code, a write that
 * failed) is rebuilt from the run's record, and saved for the next read. A summary is trusted to
 * come from this bucket: a database belongs to one bucket, whose records are never rewritten.
 */
export interface RunList {
  /** Names the runs' revisions: the same tag means the same list. */
  tag: string;
  /** Absent when the caller already has the list `tag` names. */
  runs?: EvaluationRun[];
}

const RUN_ID = /^[a-f0-9-]{36}$/;

function tagOf(revisions: Iterable<readonly [string, number]>): string {
  const lines = [...revisions].map(([id, revision]) => `${id}:${revision}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("base64url").slice(0, 27);
}

const newestFirst = (runs: EvaluationRun[]) =>
  runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

/** Records being read to rebuild a summary, so requests that overlap share one read of each. */
const rebuilding = new Map<string, Promise<EvaluationRun | undefined>>();

function rebuild(
  store: ArtifactStore,
  repoId: number,
  id: string,
): Promise<EvaluationRun | undefined> {
  const key = `${repoId}/${id}`;
  const pending = rebuilding.get(key);
  if (pending) return pending;
  const read = (async () => {
    const run = await getEvaluation(store, repoId, id);
    if (!run) return undefined;
    // Saved while the list is answered: the list need not wait for the database.
    void keepSummary(store, run);
    return runSummary(run);
  })().finally(() => rebuilding.delete(key));
  rebuilding.set(key, read);
  return read;
}

/**
 * The repository's runs, or only their tag when it is `have`: a caller polling an unchanged list
 * is told so without the list being read.
 */
export async function listRuns(
  store: ArtifactStore,
  repoId: number,
  have?: string,
): Promise<RunList> {
  const summaries = runSummariesOf(store);
  if (!summaries) {
    // No database here (a local run): every record is read, as before summaries.
    const runs = (await listEvaluations(store, repoId)).map(runSummary);
    const tag = tagOf(runs.map((run) => [run.id, run.revision]));
    return tag === have ? { tag } : { tag, runs };
  }
  const [folders, revisions] = await Promise.all([
    store.folders(evaluationPrefix(repoId).slice(0, -1)),
    summaries.revisions(repoId),
  ]);
  const ids = folders.filter((id) => RUN_ID.test(id));
  // Each run's summary revision if it is current, else its rebuilt summary.
  const checked = await Promise.all(
    ids.map(async (id) => {
      const revision = revisions.get(id);
      if (revision !== undefined && !(await savedSince(store, { repoId, id, revision })))
        return { id, revision };
      const run = await rebuild(store, repoId, id);
      return run ? { id, revision: run.revision, run } : undefined;
    }),
  );
  const current = checked.filter((entry) => entry !== undefined);
  if (have !== undefined && have === tagOf(current.map((entry) => [entry.id, entry.revision])))
    return { tag: have };
  const stored = new Map(
    current.some((entry) => !entry.run)
      ? (await summaries.list(repoId)).map((summary) => [summary.id, summary])
      : [],
  );
  const runs = await Promise.all(
    current.map(async ({ id, run }) => {
      if (run) return run;
      const summary = stored.get(id);
      // A summary can only have moved on since it was checked; one gone altogether (its
      // repository disconnected meanwhile) is read from the record.
      return summary ? (JSON.parse(summary.body) as EvaluationRun) : rebuild(store, repoId, id);
    }),
  );
  const listed = newestFirst(runs.filter((run) => run !== undefined));
  return { tag: tagOf(listed.map((run) => [run.id, run.revision])), runs: listed };
}
