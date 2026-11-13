import { type ComparisonCondition, MAX_PAIRS } from "../contracts/conditions.js";
import type { SavedHarness } from "../db/saved-harnesses.js";
import { type RunCondition, runCondition } from "./conditions.js";
import type { EvaluationDataset } from "./dataset.js";
import type { EvaluationInput } from "./types.js";

/** One thing a comparison runs every configuration under: the baseline, or a pair. */
export interface ConditionRuns {
  /** None for the baseline, the tasks as they are. */
  condition?: RunCondition;
  /** The tasks it runs: as its environment built them, when it names one. */
  tasks: EvaluationInput["tasks"];
  /** The credential that serves its subagent model; the first that can, when none is named. */
  subagentCredentialId?: string;
}

export const NOTHING_TO_RUN = "Run the tasks as they are, or pick a harness or an environment";

/**
 * Every pair of the picked harnesses and environments, each list with "as it is" beside what was
 * picked, but for the tasks as they are with the harness as it is: the baseline, which runs apart.
 */
function pairs(selection: {
  harnesses?: readonly number[] | undefined;
  environments?: readonly number[] | undefined;
}): ComparisonCondition[] {
  const harnesses = [undefined, ...(selection.harnesses ?? [])];
  const environments = [undefined, ...(selection.environments ?? [])];
  return environments.flatMap((environment) =>
    harnesses.flatMap((saved) =>
      saved === undefined && environment === undefined
        ? []
        : [
            {
              ...(saved !== undefined ? { saved } : {}),
              ...(environment !== undefined ? { environment } : {}),
            },
          ],
    ),
  );
}

/**
 * What a comparison runs every configuration under: the baseline, unless it was left out, and
 * each pair of its harnesses and environments, frozen as they are now. A saved harness is read
 * from the workspace and named with the environment beside it; a pair with an environment runs
 * each task that environment has ready, from its variant.
 */
export async function comparisonConditions(
  selection: {
    harnesses?: readonly number[] | undefined;
    environments?: readonly number[] | undefined;
    conditions?: readonly ComparisonCondition[] | undefined;
    baseline?: boolean | undefined;
  },
  frozen: EvaluationInput["tasks"],
  known: {
    /** The workspace's saved harnesses, by id. */
    saved?: ((id: number) => Promise<SavedHarness | undefined>) | undefined;
    /** The scope's environments (EvaluationDataset.environment). */
    environments?: EvaluationDataset["environment"] | undefined;
  },
): Promise<ConditionRuns[]> {
  const runs: ConditionRuns[] = selection.baseline === false ? [] : [{ tasks: frozen }];
  const picks = [...pairs(selection), ...(selection.conditions ?? [])];
  if (picks.length > MAX_PAIRS)
    throw new Error(
      `That is ${picks.length} harness and environment pairs; pick at most ${MAX_PAIRS}`,
    );
  for (const picked of picks) {
    let written: Parameters<typeof runCondition>[0];
    let subagentCredentialId: string | undefined;
    if ("name" in picked) {
      written = picked;
      subagentCredentialId = picked.subagent?.credentialId;
    } else {
      const saved = picked.saved === undefined ? undefined : await known.saved?.(picked.saved);
      if (picked.saved !== undefined && !saved)
        throw new Error(`No saved harness ${picked.saved} in this workspace`);
      // Named for its environment too once that is found, so results tell the two apart.
      written = {
        name: saved?.name ?? "",
        harness: saved?.agent,
        skills: saved?.skills ?? [],
        instructions: saved?.instructions,
        harnessOptions: saved?.harnessOptions,
        subagent: saved?.subagent && {
          catalogId: saved.subagent.catalogId,
          prompt: saved.subagent.prompt,
        },
        environment: picked.environment,
      };
      // A credential named beside it, as older clients and retries do, serves in place of its own.
      if (saved?.subagent)
        subagentCredentialId = picked.subagentCredentialId ?? saved.subagent.credentialId;
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
  if (runs.length === 0) throw new Error(NOTHING_TO_RUN);
  const ids = runs.flatMap(({ condition }) => (condition ? [condition.id] : []));
  if (new Set(ids).size !== ids.length) throw new Error("Pick each harness and environment once");
  return runs;
}
