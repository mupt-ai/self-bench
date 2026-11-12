import { settingOf } from "../../../../src/evaluation/setting";
import type { EvaluationRun, Harness } from "./api";

/**
 * The release's setting for a run's trials on one harness (settingOf in
 * src/evaluation/setting.ts): model, harness and reasoning, with any run condition and subagent
 * model, whatever route reached the model. A run from before runs recorded their credentials has
 * none, and is left out, as a release leaves it out.
 */
export function identityOf(run: EvaluationRun, harness: Harness) {
  const setting = settingOf(run, harness);
  if (!setting) return undefined;
  return {
    key: setting.key,
    label: setting.label,
    modelName: setting.modelName,
    provider: setting.provider,
    harness,
    ...(run.thinking ? { thinking: run.thinking } : {}),
    ...(setting.condition ? { condition: setting.condition } : {}),
    ...(setting.subagent ? { subagent: setting.subagent } : {}),
  };
}
export type Identity = NonNullable<ReturnType<typeof identityOf>>;
