import type { ArtifactStore } from "../artifacts.js";
import { archivedCandidates } from "../viewer/archived.js";
import type { CandidateSummary } from "../viewer/types.js";
import type { PipelineStatus, TaskStore, TaskUpsert } from "./task-store.js";

const DEFINITION_CONCURRENCY = 8;

/**
 * Walks one run in the artifact store and upserts a task row per candidate. Reviews on
 * existing rows are kept; everything the pipeline decided is refreshed.
 */
export async function syncRun(options: {
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  readonly repo: { readonly id: number; readonly fullName: string };
  readonly runId: string;
}): Promise<{ synced: number }> {
  const { tasks, artifacts, repo, runId } = options;
  const list = await archivedCandidates(artifacts, runId);
  const rows: TaskUpsert[] = [];
  const queue = [...list.candidates];
  const workers = Array.from({ length: DEFINITION_CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      rows.push(await taskRow(artifacts, repo, runId, next));
    }
  });
  await Promise.all(workers);
  await tasks.upsertMany(rows);
  return { synced: rows.length };
}

async function taskRow(
  artifacts: ArtifactStore,
  repo: { readonly id: number; readonly fullName: string },
  runId: string,
  candidate: CandidateSummary,
): Promise<TaskUpsert> {
  const definition = candidate.definitionKey
    ? await readJson(artifacts, candidate.definitionKey)
    : undefined;
  const pr = sourcePullRequest(candidate, definition, repo.fullName);
  return {
    repoId: repo.id,
    runId,
    candidateId: candidate.candidateId,
    taskId: candidate.taskId,
    ...pr,
    difficulty: candidate.difficulty,
    pipelineStatus: pipelineStatus(candidate),
    stage: candidate.stage,
    ...(candidate.reason
      ? { reason: candidate.reason }
      : candidate.reasonSummary
        ? { reason: candidate.reasonSummary }
        : {}),
    ...(candidate.bundleKey ? { bundleKey: candidate.bundleKey } : {}),
    ...(definition ? { definition } : {}),
  };
}

/** Archived runs keep no verdict beyond "accepted"; anything else ended without one. */
export function pipelineStatus(candidate: Pick<CandidateSummary, "status">): PipelineStatus {
  switch (candidate.status) {
    case "accepted":
      return "accepted";
    case "infrastructure_failed":
      return "infrastructure_failed";
    case "rejected":
    case "archived":
      return "rejected";
    default:
      return "in_progress";
  }
}

/** The definition names the PR; task ids carry it too ("…-pr-91809…") when no definition exists. */
export function sourcePullRequest(
  candidate: Pick<CandidateSummary, "taskId">,
  definition: Record<string, unknown> | undefined,
  fullName: string,
): { sourcePr: number; sourceUrl: string } | undefined {
  if (typeof definition?.sourcePr === "number") {
    return {
      sourcePr: definition.sourcePr,
      sourceUrl:
        typeof definition.sourceUrl === "string"
          ? definition.sourceUrl
          : `https://github.com/${fullName}/pull/${definition.sourcePr}`,
    };
  }
  const number = /-pr-(\d+)(?:-|$)/.exec(candidate.taskId)?.[1];
  if (!number) return undefined;
  return { sourcePr: Number(number), sourceUrl: `https://github.com/${fullName}/pull/${number}` };
}

async function readJson(
  store: ArtifactStore,
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const bytes = await store.getByKey(key).catch(() => undefined);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
