import type {
  CandidateArtifacts,
  CandidateList,
  CandidateSummary,
  TaskFiles,
  TaskRow,
} from "../types";
import type { ApiClient, TaskSource } from "./types";

export async function openRunSource(api: ApiClient, runId: string): Promise<TaskSource> {
  const list = await api.json<CandidateList>(`/v1/runs/${encodeURIComponent(runId)}/candidates`);
  const rows = list.candidates.map(rowFor);
  const artifactCache = new Map<string, Promise<CandidateArtifacts>>();
  const artifacts = (id: string): Promise<CandidateArtifacts> => {
    const cached = artifactCache.get(id);
    if (cached) return cached;
    const pending = api.json<CandidateArtifacts>(
      `/v1/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(id)}/artifacts`,
    );
    artifactCache.set(id, pending);
    pending.catch(() => artifactCache.delete(id));
    return pending;
  };
  const loadBundle = (key: string): Promise<TaskFiles> =>
    api.json<TaskFiles>(
      `/v1/runs/${encodeURIComponent(runId)}/bundle?key=${encodeURIComponent(key)}`,
    );
  return {
    kind: "run",
    label: runId,
    summary: summaryFor(list),
    rows,
    artifacts,
    loadBundle,
    readArtifact: (key, options) =>
      api.text(
        `/v1/runs/${encodeURIComponent(runId)}/artifacts?key=${encodeURIComponent(key)}${
          options?.start ? `&start=${options.start}` : ""
        }`,
      ),
    loadFiles: async (id) => {
      const found = await artifacts(id);
      const bundle = found.bundles[0];
      if (!bundle) return { taskId: id, files: [] };
      return loadBundle(bundle.key);
    },
  };
}

function rowFor(candidate: CandidateSummary): TaskRow {
  const definition = candidate.definition;
  return {
    id: candidate.taskId,
    name: candidate.taskId,
    candidateId: candidate.candidateId,
    difficulty: candidate.difficulty,
    status: candidate.status,
    stage: candidate.stage,
    ...(definition
      ? {
          runner: definition.runner,
          testCommand: definition.testCommand,
          failToPass: definition.failToPass,
          passToPass: definition.passToPass,
          sourcePr: definition.sourcePr,
          sourceUrl: definition.sourceUrl,
        }
      : {}),
    ...(candidate.reason ? { reason: candidate.reason } : {}),
    ...(candidate.reasonSummary ? { reasonSummary: candidate.reasonSummary } : {}),
  };
}

function summaryFor(list: CandidateList): string {
  const counts = new Map<string, number>();
  for (const candidate of list.candidates) {
    counts.set(candidate.stage, (counts.get(candidate.stage) ?? 0) + 1);
  }
  const requested = list.requestedByDifficulty
    ? ` · requested ${list.requestedByDifficulty.easy}/${list.requestedByDifficulty.medium}/${list.requestedByDifficulty.hard}`
    : "";
  return `phase ${list.phase}${requested}`;
}
