import type { ComparisonCondition } from "../contracts/conditions.js";
import type { SavedCondition } from "../db/saved-conditions.js";
import { type RunCondition, runCondition } from "./conditions.js";
import type { EvaluationDataset } from "./dataset.js";
import type { EvaluationInput } from "./types.js";

/** One thing a comparison runs every configuration under: the baseline, or a condition. */
export interface ConditionRuns {
  /** None for the baseline, the tasks as they are. */
  condition?: RunCondition;
  /** The tasks it runs: as its environment built them, when it names one. */
  tasks: EvaluationInput["tasks"];
  /** The credential picked to serve its subagent model; the first that can, when none was. */
  subagentCredentialId?: string;
}

/**
 * What a comparison runs every configuration under: the baseline, unless it was left out, and
 * each of its conditions, frozen as they are now. A saved condition is read from the workspace
 * and named with the environment picked beside it; a condition with an environment runs each task
 * that environment has ready, from its variant.
 */
export async function comparisonConditions(
  selection: {
    conditions?: readonly ComparisonCondition[] | undefined;
    baseline?: boolean | undefined;
  },
  frozen: EvaluationInput["tasks"],
  known: {
    /** The workspace's saved conditions, by id. */
    saved?: ((id: number) => Promise<SavedCondition | undefined>) | undefined;
    /** The scope's environments (EvaluationDataset.environment). */
    environments?: EvaluationDataset["environment"] | undefined;
  },
): Promise<ConditionRuns[]> {
  const runs: ConditionRuns[] = selection.baseline === false ? [] : [{ tasks: frozen }];
  for (const picked of selection.conditions ?? []) {
    let written: Parameters<typeof runCondition>[0];
    let subagentCredentialId: string | undefined;
    if ("name" in picked) {
      written = picked;
      subagentCredentialId = picked.subagent?.credentialId;
    } else {
      const saved = picked.saved === undefined ? undefined : await known.saved?.(picked.saved);
      if (picked.saved !== undefined && !saved)
        throw new Error(`No saved condition ${picked.saved} in this workspace`);
      // Named for its environment too once that is found, so results tell the two apart.
      written = {
        name: saved?.name ?? "",
        skills: saved?.skills ?? [],
        instructions: saved?.instructions,
        harnessOptions: saved?.harnessOptions,
        subagent: saved?.subagent,
        environment: picked.environment,
      };
      if (saved?.subagent) subagentCredentialId = picked.subagentCredentialId;
    }
    let tasks = frozen;
    let environment: string | undefined;
    if (written.environment !== undefined) {
      const built = await known.environments?.(written.environment, frozen);
      const named = written.name || `Environment ${written.environment}`;
      if (!built) throw new Error(`${named}: no such environment in this repository`);
      if (built.tasks.length === 0)
        throw new Error(`${named}: no picked task is ready in ${built.name} yet`);
      ({ tasks, name: environment } = built);
      if (!("name" in picked))
        written = {
          ...written,
          name: written.name ? `${written.name} · ${built.name}` : built.name,
        };
    }
    runs.push({
      condition: runCondition(written, environment),
      tasks,
      ...(subagentCredentialId ? { subagentCredentialId } : {}),
    });
  }
  if (runs.length === 0) throw new Error("Run the baseline or at least one condition");
  const ids = runs.flatMap(({ condition }) => (condition ? [condition.id] : []));
  if (new Set(ids).size !== ids.length) throw new Error("Pick each condition once");
  return runs;
}
