import type { ArtifactStore } from "../../artifacts/index.js";
import type { ConnectedRepo } from "../../db/repos.js";
import type { Vault } from "../../db/vault.js";
import { evaluationPrefix } from "../../evaluation/store.js";
import { trialInput } from "../../evaluation/trial-input.js";
import type { EvaluationRun } from "../../evaluation/types.js";

/** Only the task frozen for this evaluation, never the dataset's current replacement. */
export async function frozenTrialBundle(
  vault: Vault | undefined,
  repo: ConnectedRepo,
  run: EvaluationRun,
  index: number,
): Promise<string | undefined> {
  const record = run.comparisonId ? await vault?.comparisons.find(run.comparisonId) : undefined;
  const frozen =
    record?.repoId === repo.id && record.orgId === repo.orgId
      ? record.inputs.find((input) => input.id === run.id)
      : undefined;
  return frozen && trialInput(frozen, index).tasks[0]?.bundleKey;
}

/**
 * Where a trial's task files are: the bundle frozen for its evaluation, or else the files its
 * evaluation kept (`tasks/<index>.json`, shaped as an expanded bundle). Undefined when neither is.
 */
export async function trialTaskFiles(
  artifacts: ArtifactStore,
  vault: Vault | undefined,
  repo: ConnectedRepo,
  run: EvaluationRun,
  index: number,
): Promise<{ bundleKey: string } | { filesKey: string } | undefined> {
  const bundleKey = await frozenTrialBundle(vault, repo, run, index);
  if (bundleKey && (await artifacts.stat(bundleKey))) return { bundleKey };
  const filesKey = `${evaluationPrefix(repo.id, run.id)}tasks/${index}.json`;
  return (await artifacts.stat(filesKey)) ? { filesKey } : undefined;
}
