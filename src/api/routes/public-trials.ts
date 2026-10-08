import type { ReleaseLine } from "../../db/releases.js";
import type { EvaluationRun } from "../../evaluation/types.js";
import { publishedTrial, type ReleasedResult } from "../../public/release-trials.js";
import { type TaggedBody, tagged } from "../tagged.js";

/** Trials whose answers are kept, most recently used last. */
const KEPT_TRIALS = 128;

/** One published trial: the release's record of it, and the line whose repository ran it. */
export interface ChosenTrial {
  line: ReleaseLine;
  settingKey: string;
  settingId: string;
  taskKey: string;
  taskId: string;
  result: ReleasedResult;
}

export interface TrialBodiesOptions {
  /** The run a released trial belongs to (release-sources.ts `releasedRun`). */
  releasedRun(line: ReleaseLine, evaluationId: string): Promise<EvaluationRun | undefined>;
}

/**
 * Published trials' answers, each built from its run the first time it is asked for, then kept:
 * a released trial never changes, and a run holds every trial's logs, so reading one is the
 * cost worth saving. Undefined when the run, or the trial in it, is gone.
 */
export function createTrialBodies(options: TrialBodiesOptions) {
  const kept = new Map<string, Promise<TaggedBody | undefined>>();
  return (releaseId: string, chosen: ChosenTrial): Promise<TaggedBody | undefined> => {
    const key = JSON.stringify([releaseId, chosen.taskId, chosen.settingId]);
    const found = kept.get(key);
    if (found) {
      kept.delete(key);
      kept.set(key, found);
      return found;
    }
    const { evaluationId } = chosen.result;
    const reading = (async () => {
      const run = evaluationId ? await options.releasedRun(chosen.line, evaluationId) : undefined;
      const trial = run && publishedTrial(run, chosen);
      return trial ? tagged(JSON.stringify(trial)) : undefined;
    })();
    // A failed read is not kept: the next request reads again.
    reading.catch(() => kept.delete(key));
    kept.set(key, reading);
    for (const oldest of kept.keys()) {
      if (kept.size <= KEPT_TRIALS) break;
      kept.delete(oldest);
    }
    return reading;
  };
}
