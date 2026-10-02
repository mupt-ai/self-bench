import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts/index.js";
import type { RunSummaryStore } from "../db/evaluation-summaries.js";
import { reportError } from "../lib/telemetry/sentry.js";
import type { EvaluationInput, EvaluationRun } from "./types.js";

export function evaluationPrefix(repoId: number, id = ""): string {
  if (!Number.isSafeInteger(repoId) || repoId < 1 || (id && !/^[a-f0-9-]{36}$/.test(id)))
    throw new Error("Invalid evaluation identity");
  return `evaluations/repos/${repoId}/${id ? `${id}/` : ""}`;
}
export function initialEvaluation(input: EvaluationInput, modelLabel: string): EvaluationRun {
  const { tasks, ...metadata } = input;
  return {
    ...metadata,
    revision: 0,
    datasetKey: createHash("sha256")
      .update(
        JSON.stringify(
          tasks
            .map(({ runId, taskId, bundleKey }) => [runId, taskId, bundleKey])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        ),
      )
      .digest("hex"),
    modelLabel,
    status: "queued",
    trials: tasks.flatMap((task) =>
      input.harnesses.map((harness) => ({
        taskId: task.taskId,
        runId: task.runId,
        harness,
        status: "queued",
        rewards: {},
        log: "",
        steps: [],
        artifacts: [],
      })),
    ),
  };
}
export async function saveEvaluation(store: ArtifactStore, run: EvaluationRun): Promise<void> {
  run.revision += 1;
  await store.put(snapshotKey(run), Buffer.from(JSON.stringify(run)), "application/json");
  await saveSummary(store, run);
}

/** A run without its trials' logs, transcripts and artifact lists: what lists of runs show. */
export function runSummary(run: EvaluationRun): EvaluationRun {
  return {
    ...run,
    trials: run.trials.map((trial) => ({ ...trial, log: "", steps: [], artifacts: [] })),
  };
}

/**
 * Where each artifact store's run summaries are kept, in processes that have the database. Kept
 * beside the store rather than passed to every function that saves a run, so no path that saves
 * one can leave its summary behind.
 */
const summaryStores = new WeakMap<ArtifactStore, RunSummaryStore>();
/** Has every run saved to `store` also save its summary to `summaries`, and run lists read them. */
export function keepRunSummaries(store: ArtifactStore, summaries: RunSummaryStore): void {
  summaryStores.set(store, summaries);
}
export function runSummariesOf(store: ArtifactStore): RunSummaryStore | undefined {
  return summaryStores.get(store);
}

/** A summary is a copy: a slow database must not hold a trial up for longer than this. */
const SUMMARY_SAVE_MS = 2_000;
/** After a save fails, how long summaries wait: a database that is down costs a run one wait. */
const SUMMARY_PAUSE_MS = 30_000;
const pausedUntil = new WeakMap<RunSummaryStore, number>();

/**
 * Saves a saved run's summary. The snapshot is the record, so this never fails or long delays the
 * save it follows: a summary that was not saved is found behind its run and rebuilt by the next
 * list of runs (run-list.ts).
 */
export async function saveSummary(store: ArtifactStore, run: EvaluationRun): Promise<void> {
  const summaries = summaryStores.get(store);
  if (!summaries || Date.now() < (pausedUntil.get(summaries) ?? 0)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { id, revision } = run;
    const saved = summaries.save(run.repoId, {
      id,
      revision,
      body: JSON.stringify(runSummary(run)),
    });
    // Should it lose the race below, its own failure is nobody's to handle.
    saved.catch(() => undefined);
    await Promise.race([
      saved,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), SUMMARY_SAVE_MS);
      }),
    ]);
  } catch (error) {
    pausedUntil.set(summaries, Date.now() + SUMMARY_PAUSE_MS);
    // A query's own message repeats the whole summary; its cause says what went wrong.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const reason = (cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
    const message = `evaluation ${run.id}: summary of revision ${run.revision} not saved: ${reason}`;
    console.warn(message);
    reportError(new Error(message), { repeatKey: "evaluation-summary-save" });
  } finally {
    clearTimeout(timer);
  }
}
/** Thrown instead of starting work that may already have spent model money; never retried. */
export class RepeatSpendError extends Error {
  override name = "RepeatSpendError";
  constructor() {
    super("Evaluation already attempted; refusing to repeat model spend");
  }
}
/**
 * Applies `change` to the latest record and saves it as the next revision. Snapshots are
 * create-only, so two writers that read the same revision cannot both save the next one: the
 * loser re-reads and applies its change again. `change` returns false to leave the record as is.
 */
export async function updateEvaluation(
  store: ArtifactStore,
  repoId: number,
  id: string,
  change: (run: EvaluationRun) => unknown,
): Promise<EvaluationRun> {
  // Every trial of an evaluation can start at once, so writers back off exponentially with full
  // jitter and keep trying for two minutes rather than a fixed number of attempts.
  const deadline = Date.now() + 120_000;
  for (let attempt = 1; ; attempt += 1) {
    const run = await getEvaluation(store, repoId, id);
    if (!run) throw new Error("Evaluation record is missing");
    if (change(run) === false) return run;
    try {
      await saveEvaluation(store, run);
      return run;
    } catch (error) {
      if (Date.now() >= deadline || !(await store.stat(snapshotKey(run)))) throw error;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * Math.min(2_000, 50 * 2 ** attempt)),
    );
  }
}
type Revision = Pick<EvaluationRun, "repoId" | "id" | "revision">;
function snapshotKey(run: Revision): string {
  return `${evaluationPrefix(run.repoId, run.id)}snapshots/${String(run.revision).padStart(10, "0")}.json`;
}
/**
 * Whether a run has been saved since `run`'s revision. Revisions count up by one, so the next
 * one's snapshot is there exactly when it has.
 */
export async function savedSince(store: ArtifactStore, run: Revision): Promise<boolean> {
  return !!(await store.stat(snapshotKey({ ...run, revision: run.revision + 1 })));
}
export async function getEvaluation(
  store: ArtifactStore,
  repoId: number,
  id: string,
): Promise<EvaluationRun | undefined> {
  const entries = (await store.list(`${evaluationPrefix(repoId, id)}snapshots`)).filter((entry) =>
    /\/snapshots\/\d{10}\.json$/.test(entry.key),
  );
  const latest = entries.sort((left, right) => right.key.localeCompare(left.key))[0];
  const bytes = latest ? await store.getByKey(latest.key) : undefined;
  return bytes ? (JSON.parse(Buffer.from(bytes).toString("utf8")) as EvaluationRun) : undefined;
}
export async function listEvaluations(
  store: ArtifactStore,
  repoId: number,
): Promise<EvaluationRun[]> {
  const prefix = evaluationPrefix(repoId);
  const entries = (await store.list(prefix.slice(0, -1))).filter((entry) =>
    entry.key.startsWith(prefix),
  );
  const latest = new Map<string, string>();
  for (const entry of entries) {
    if (!/\/snapshots\/\d{10}\.json$/.test(entry.key)) continue;
    const id = entry.key.slice(prefix.length).split("/")[0];
    if (id && entry.key > (latest.get(id) ?? "")) latest.set(id, entry.key);
  }
  const runs = await Promise.all(
    [...latest.values()].map(async (key) => {
      const bytes = await store.getByKey(key);
      return bytes ? (JSON.parse(Buffer.from(bytes).toString("utf8")) as EvaluationRun) : undefined;
    }),
  );
  return runs
    .filter((run): run is EvaluationRun => !!run)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
