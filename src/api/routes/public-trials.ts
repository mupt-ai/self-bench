import type { ReleaseLine } from "../../db/releases.js";
import type { EvaluationRun } from "../../evaluation/types.js";
import {
  fullerSteps,
  publishedTrial,
  type ReleasedResult,
  type TrialSource,
} from "../../public/release-trials.js";
import { type TaggedBody, tagged } from "../tagged.js";

/** Trials whose answers are kept, most recently used last. */
const KEPT_TRIALS = 128;
/** Runs kept while their trials are read: a run holds every trial, so it is large. */
const KEPT_RUNS = 4;

/**
 * `key`'s entry of `cache`, read with `load` when missing, as the most recently used. A read
 * that fails or finds nothing is not kept, so the next request reads again.
 */
function cached<T>(
  cache: Map<string, Promise<T | undefined>>,
  limit: number,
  key: string,
  load: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const found = cache.get(key);
  if (found) {
    cache.delete(key);
    cache.set(key, found);
    return found;
  }
  const reading = load();
  const forget = () => {
    if (cache.get(key) === reading) cache.delete(key);
  };
  reading.then((value) => value === undefined && forget(), forget);
  cache.set(key, reading);
  for (const oldest of cache.keys()) {
    if (cache.size <= limit) break;
    cache.delete(oldest);
  }
  return reading;
}

/** One published trial: the release's record of it, and the line whose repository ran it. */
export interface ChosenTrial {
  line: ReleaseLine;
  settingKey: string;
  settingId: string;
  taskKey: string;
  taskId: string;
  result: ReleasedResult;
  /** The release's custom endpoint hosts, redacted from what is served. */
  endpointHosts: readonly string[];
}

export interface TrialBodiesOptions {
  /** Where released trials are read from (release-sources.ts `releasedTrials`). */
  trials: TrialSource;
}

/**
 * Published trials' answers, each built from its run the first time it is asked for, then kept:
 * a released trial never changes, and a run holds every trial's logs, so reading one is the
 * cost worth saving. The runs themselves are kept briefly too, since a row of the grid reads
 * many trials of one run. Undefined when the run, or the trial in it, is gone.
 */
export function createTrialBodies(options: TrialBodiesOptions) {
  const bodies = new Map<string, Promise<TaggedBody | undefined>>();
  const runs = new Map<string, Promise<EvaluationRun | undefined>>();
  return (releaseId: string, chosen: ChosenTrial): Promise<TaggedBody | undefined> => {
    const key = JSON.stringify([releaseId, chosen.taskId, chosen.settingId]);
    return cached(bodies, KEPT_TRIALS, key, async () => {
      const { evaluationId } = chosen.result;
      if (!evaluationId) return undefined;
      const { trials } = options;
      const runKey = JSON.stringify([chosen.line, evaluationId]);
      const run = await cached(runs, KEPT_RUNS, runKey, () =>
        trials.run(chosen.line, evaluationId),
      );
      const recorded =
        chosen.result.trialIndex === undefined ? undefined : run?.trials[chosen.result.trialIndex];
      if (!run || !recorded) return undefined;
      const steps = await fullerSteps(recorded, (name) =>
        trials.artifact(chosen.line, evaluationId, name),
      );
      const trial = publishedTrial(run, chosen, steps);
      return trial ? tagged(JSON.stringify(trial)) : undefined;
    });
  };
}
