import type { ArtifactStore } from "../artifacts/index.js";
import type { EvaluationDataset } from "./dataset.js";
import { listRuns, type RunList } from "./run-list.js";
import type { EvaluationScope } from "./scope.js";
import { getEvaluation } from "./store.js";
import type { EvaluationRun } from "./types.js";

/**
 * A scope's runs together with those of the scopes its dataset draws on too (`sources`): a
 * repository group's own runs, then its members'. Each member's run is marked with the
 * repository it came from. The tag names every list, so a poll still answers 304 while none moved.
 */
export async function scopedRuns(
  store: ArtifactStore,
  scope: EvaluationScope,
  dataset: Pick<EvaluationDataset, "sources">,
  have?: string,
): Promise<RunList> {
  const sources = dataset.sources ?? [];
  if (sources.length === 0) return listRuns(store, scope, have);
  const lists = await Promise.all([
    listRuns(store, scope),
    ...sources.map(async (source) => {
      const listed = await listRuns(store, source.scope);
      return {
        ...listed,
        runs: listed.runs?.map((run) => ({ ...run, sourceRepository: source.name })),
      };
    }),
  ]);
  const tag = lists.map((list) => list.tag).join(".");
  if (tag === have) return { tag };
  const runs = lists
    .flatMap((list) => list.runs ?? [])
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { tag, runs };
}

/** One run of the scope, or else of a scope its dataset draws on, marked as above. */
export async function scopedRun(
  store: ArtifactStore,
  scope: EvaluationScope,
  dataset: Pick<EvaluationDataset, "sources">,
  id: string,
): Promise<EvaluationRun | undefined> {
  const own = await getEvaluation(store, scope, id);
  if (own) return own;
  for (const source of dataset.sources ?? []) {
    const run = await getEvaluation(store, source.scope, id);
    if (run) return { ...run, sourceRepository: source.name };
  }
  return undefined;
}

/** The scope a run of the scope's list lives in: its own, or a source's; undefined if neither. */
export async function runScope(
  store: ArtifactStore,
  scope: EvaluationScope,
  dataset: Pick<EvaluationDataset, "sources">,
  id: string,
): Promise<EvaluationScope | undefined> {
  for (const candidate of [scope, ...(dataset.sources ?? []).map((source) => source.scope)])
    if (await getEvaluation(store, candidate, id)) return candidate;
  return undefined;
}
