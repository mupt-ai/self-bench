import { conditionHarness } from "../../../../src/contracts/conditions";
import { harnessLabels } from "../../../../src/evaluation/models";
import type { SavedCondition } from "./condition-api";

/**
 * What a saved condition changes, as short parts: its harness, then "2 skills", "subagents on
 * Claude Haiku 5.5".
 */
export function conditionSummary(
  condition: Pick<
    SavedCondition,
    "harness" | "skills" | "instructions" | "harnessOptions" | "subagent"
  >,
  models: readonly { id: string; label: string }[] = [],
): string[] {
  const options = Object.values(condition.harnessOptions ?? {}).flatMap((set) =>
    Object.keys(set ?? {}),
  ).length;
  const { subagent } = condition;
  const count = (many: number, one: string) => `${many} ${one}${many === 1 ? "" : "s"}`;
  const harness = conditionHarness(condition);
  return [
    ...(harness ? [harnessLabels[harness]] : []),
    ...(condition.skills.length ? [count(condition.skills.length, "skill")] : []),
    ...(condition.instructions ? ["extra instructions"] : []),
    ...(options ? [count(options, "harness option")] : []),
    ...(subagent
      ? [
          `subagents on ${models.find((model) => model.id === subagent.catalogId)?.label ?? subagent.catalogId}`,
        ]
      : []),
  ];
}
