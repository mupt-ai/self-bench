import type { ArtifactStore } from "../artifacts/index.js";
import type { EvaluationScope } from "./scope.js";
import { evaluationPrefix } from "./store.js";
import type { EvaluationRun } from "./types.js";

/**
 * When a trial's agent ran, from Harbor's `agent_execution` phase. The trial's own start and
 * finish cover setup and grading too; the agent's time is this phase alone.
 */
export interface AgentTiming {
  agentStartedAt: string;
  agentFinishedAt: string;
}

/** Harbor's `agent_execution` phase from a trial's result.json, when the agent ran. */
export function agentTimingOf(result: unknown): AgentTiming | undefined {
  const phase = (
    result as { agent_execution?: { started_at?: unknown; finished_at?: unknown } } | null
  )?.agent_execution;
  const started = phase?.started_at;
  const finished = phase?.finished_at;
  return typeof started === "string" && typeof finished === "string" && started && finished
    ? { agentStartedAt: started, agentFinishedAt: finished }
    : undefined;
}

/**
 * The agent timings of trials recorded before the runner kept them, written once per evaluation
 * as `agent-timing.json` beside its snapshots (by trial index). Timings already on a trial win.
 */
const SIDECAR = "agent-timing.json";
const KEPT = 4000;
// Kept per store, so a store's files never answer for another's.
const sidecarsByStore = new WeakMap<
  ArtifactStore,
  Map<string, Promise<Map<number, AgentTiming> | undefined>>
>();

function sidecarOf(
  store: ArtifactStore,
  scope: EvaluationScope,
  id: string,
): Promise<Map<number, AgentTiming> | undefined> {
  const key = `${evaluationPrefix(scope, id)}${SIDECAR}`;
  let sidecars = sidecarsByStore.get(store);
  if (!sidecars) {
    sidecars = new Map();
    sidecarsByStore.set(store, sidecars);
  }
  const cache = sidecars;
  const found = cache.get(key);
  if (found) {
    // Most recently read last, so the ones still in use are the last to go.
    cache.delete(key);
    cache.set(key, found);
    return found;
  }
  // The file never changes once written, so what is read, missing or not, is kept.
  const reading = (async () => {
    // Most evaluations have none, so the check is a stat; only a file that is there is read.
    if (!(await store.stat(key))) return undefined;
    const bytes = await store.getByKey(key);
    if (!bytes) return undefined;
    const document = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      trials?: Record<string, { startedAt?: unknown; finishedAt?: unknown }>;
    };
    const timings = new Map<number, AgentTiming>();
    for (const [index, entry] of Object.entries(document.trials ?? {})) {
      if (typeof entry.startedAt === "string" && typeof entry.finishedAt === "string")
        timings.set(Number(index), {
          agentStartedAt: entry.startedAt,
          agentFinishedAt: entry.finishedAt,
        });
    }
    return timings;
  })();
  // A failed read is not kept: the next one reads again.
  reading.catch(() => cache.delete(key));
  cache.set(key, reading);
  while (cache.size > KEPT) cache.delete(cache.keys().next().value as string);
  return reading;
}

/**
 * The run, with each trial's agent timing from its record or, for an older one, the sidecar. A
 * sidecar that cannot be read is skipped, and read again next time.
 */
export async function withAgentTimings(
  store: ArtifactStore,
  scope: EvaluationScope,
  run: EvaluationRun,
): Promise<EvaluationRun> {
  // The timings only add to a run already read: one that cannot be read leaves it as it was.
  const timings = await sidecarOf(store, scope, run.id).catch(() => undefined);
  if (!timings) return run;
  return {
    ...run,
    trials: run.trials.map((trial, index) => {
      if (trial.agentStartedAt) return trial;
      const timing = timings.get(index);
      return timing ? { ...trial, ...timing } : trial;
    }),
  };
}
